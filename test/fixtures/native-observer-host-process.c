/* Host-only TEST oracle. Never receives a candidate-reported PID and never
 * signals a discovered process. Run outside the candidate sandbox:
 *   probe discover UID MARKER
 *   probe known HOST_OWNED_PID UID MARKER
 *   probe bridge HOST_OWNED_GUARDIAN_PID UID RELAY UNIX_ARG TCP_ARG
 * MARKER is exactly 64 lowercase hex bytes and must be the child's argv[0].
 * The known mode is ONLY for a separately Node-spawned positive control.
 *
 * stdin: ready\n once, then check\n (bounded repetitions), or quit\n.
 * ready discovers one live matching process, acquires a pidfd, and rechecks
 * marker/UID/PID/starttime/session while the trusted child is still held.
 * check samples pidfd readiness with timeout zero, then reads proc identity.
 * It never waits for termination or retries to manufacture settlement.
 * A terminated process can still be a zombie: only disappearance/replacement of
 * its proc identity reports originalIdentityAbsent. Visibility errors fail.
 *
 * No /proc/PID/exe or namespace-link access is assumed. The actual namespace
 * child's successful ready is a REQUIRED visibility calibration, independently
 * of the known host-child live/terminated/reaped controls. Cmdline is mutable:
 * this is evidence about a fixed, owned test child, not arbitrary-process trust.
 * Bridge mode checks exact relay argv and the held leader/connection ancestry.
 * Its guardian PID comes ONLY from the host's actual Node ChildProcess. It holds
 * three pidfds but never signals through them or through discovered numeric PIDs.
 */
#define _GNU_SOURCE
#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error "Native host-process controls require Linux x64"
#endif

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <linux/magic.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <unistd.h>

#define PROC_BYTES 8192
#define MAX_ENTRIES 65536u

struct identity {
    int pid;
    unsigned int uid;
    uint64_t start;
    int session;
    int parent;
    int group;
    char state;
};

static int gone(int error) { return error == ENOENT || error == ESRCH; }

static int fail(const char *code) {
    const int saved = errno;
    (void)fprintf(stdout, "{\"event\":\"error\",\"code\":\"%s\",\"errno\":%d}\n", code, saved);
    (void)fflush(stdout);
    return 1;
}

static int decimal(const char *text, uint64_t maximum, uint64_t *result) {
    if (*text == '\0' || (*text == '0' && text[1] != '\0')) return -1;
    uint64_t value = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p; ++p) {
        if (*p < '0' || *p > '9' || value > (maximum - (*p - '0')) / 10) return -1;
        value = value * 10 + (*p - '0');
    }
    *result = value;
    return 0;
}

/* Open only bounded, fixed proc filenames through the host's pinned /proc fd.
 * A missing PID is distinct from a visibility or parsing failure. */
static ssize_t proc_bytes(int proc, int pid, const char *file, char bytes[PROC_BYTES + 1]) {
    char path[64];
    const int length = snprintf(path, sizeof(path), "%d/%s", pid, file);
    if (length <= 0 || (size_t)length >= sizeof(path)) { errno = EOVERFLOW; return -1; }
    const int fd = openat(proc, path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    size_t count = 0;
    int error = 0;
    while (count <= PROC_BYTES) {
        const ssize_t amount = read(fd, bytes + count, PROC_BYTES + 1 - count);
        if (amount < 0 && errno == EINTR) continue;
        if (amount < 0) { error = errno; break; }
        if (amount == 0) break;
        count += (size_t)amount;
        if (count > PROC_BYTES) { error = EOVERFLOW; break; }
    }
    if (close(fd) != 0 && error == 0) error = errno;
    if (error != 0) { errno = error; return -1; }
    bytes[count] = '\0';
    return (ssize_t)count;
}

static int stat_identity(int proc, int pid, struct identity *result) {
    char bytes[PROC_BYTES + 1];
    const ssize_t length = proc_bytes(proc, pid, "stat", bytes);
    if (length < 0) return -1;
    if (memchr(bytes, '\0', (size_t)length) != NULL) { errno = EPROTO; return -1; }
    char *end;
    errno = 0;
    const long parsed_pid = strtol(bytes, &end, 10);
    if (errno != 0 || end == bytes || parsed_pid != pid || strncmp(end, " (", 2) != 0) {
        errno = EPROTO; return -1;
    }
    /* comm can itself contain spaces and closing parentheses. */
    const char *close = strrchr(end, ')');
    if (close == NULL || close[1] != ' ' || close[2] == '\0' || close[3] != ' ') {
        errno = EPROTO; return -1;
    }
    const char state = close[2];
    if (strchr("RSDZTtXxKWPIN", state) == NULL) { errno = EPROTO; return -1; }
    const char *cursor = close + 4;
    int session = 0, parent = 0, group = 0;
    uint64_t start = 0;
    for (int field = 4; field <= 22; ++field) {
        char token[32];
        size_t count = 0;
        while (*cursor != '\0' && *cursor != ' ' && *cursor != '\n') {
            if (count + 1 >= sizeof(token)) { errno = EPROTO; return -1; }
            token[count++] = *cursor++;
        }
        token[count] = '\0';
        if (count == 0) { errno = EPROTO; return -1; }
        if (field == 4 || field == 5 || field == 6 || field == 22) {
            uint64_t value;
            if (decimal(token, field == 22 ? UINT64_MAX : INT_MAX, &value) != 0) {
                errno = EPROTO; return -1;
            }
            if (field == 4) parent = (int)value;
            else if (field == 5) group = (int)value;
            else if (field == 6) session = (int)value;
            else start = value;
        }
        if (field < 22 && *cursor != ' ') { errno = EPROTO; return -1; }
        while (*cursor == ' ') ++cursor;
    }
    *result = (struct identity){ .pid = pid, .start = start, .session = session,
        .parent = parent, .group = group, .state = state };
    return 0;
}

static int uid_matches(int proc, int pid, unsigned int uid) {
    char bytes[PROC_BYTES + 1];
    const ssize_t length = proc_bytes(proc, pid, "status", bytes);
    if (length < 0) return -1;
    if (memchr(bytes, '\0', (size_t)length) != NULL) { errno = EPROTO; return -1; }
    const char *line = bytes;
    while (*line != '\0') {
        if (strncmp(line, "Uid:\t", 5) == 0) {
            unsigned long long ids[4];
            int consumed = 0;
            if (sscanf(line, "Uid:\t%llu\t%llu\t%llu\t%llu%n",
                       &ids[0], &ids[1], &ids[2], &ids[3], &consumed) != 4 ||
                line[consumed] != '\n') { errno = EPROTO; return -1; }
            return ids[0] == uid && ids[1] == uid && ids[2] == uid && ids[3] == uid;
        }
        const char *newline = strchr(line, '\n');
        if (newline == NULL) break;
        line = newline + 1;
    }
    errno = EPROTO;
    return -1;
}

static int same_process(const struct identity *a, const struct identity *b) {
    return a->pid == b->pid && a->start == b->start && a->session == b->session;
}

/* Returns 1 for a stable match, 0 for another process, -1 for uncertain data. */
static int match(int proc, int pid, unsigned int uid, const char *marker, struct identity *result) {
    struct identity before, after;
    if (stat_identity(proc, pid, &before) != 0) return -1;
    const int owner = uid_matches(proc, pid, uid);
    if (owner <= 0) return owner;
    char command[PROC_BYTES + 1];
    const ssize_t length = proc_bytes(proc, pid, "cmdline", command);
    if (length < 0) return -1;
    if (length < 65 || memcmp(command, marker, 64) != 0 || command[64] != '\0') return 0;
    if (stat_identity(proc, pid, &after) != 0) return -1;
    if (!same_process(&before, &after)) { errno = ESTALE; return -1; }
    const int owner_after = uid_matches(proc, pid, uid);
    if (owner_after != 1) { if (owner_after == 0) errno = ESTALE; return -1; }
    if (after.state == 'Z' || after.state == 'X' || after.state == 'x') { errno = ESRCH; return -1; }
    after.uid = uid;
    *result = after;
    return 1;
}

static int discover(int proc, unsigned int uid, const char *marker, struct identity *result) {
    const int duplicate = fcntl(proc, F_DUPFD_CLOEXEC, 3);
    if (duplicate < 0) return -1;
    DIR *directory = fdopendir(duplicate);
    if (directory == NULL) { const int saved = errno; close(duplicate); errno = saved; return -1; }
    unsigned int entries = 0, matches = 0;
    int error = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (entry == NULL) { error = errno; break; }
        if (++entries > MAX_ENTRIES) { error = EOVERFLOW; break; }
        if (entry->d_name[0] < '0' || entry->d_name[0] > '9') continue;
        uint64_t pid;
        if (decimal(entry->d_name, INT_MAX, &pid) != 0 || pid == 0) { error = EPROTO; break; }
        struct identity candidate;
        const int found = match(proc, (int)pid, uid, marker, &candidate);
        if (found < 0) {
            if (gone(errno)) continue; /* An unrelated process exited during the scan. */
            error = errno; break;
        }
        if (found == 1) {
            if (++matches > 1) { error = EEXIST; break; }
            *result = candidate;
        }
    }
    if (closedir(directory) != 0 && error == 0) error = errno;
    if (error == 0 && matches != 1) error = ESRCH;
    if (error != 0) { errno = error; return -1; }
    return 0;
}

static int terminated(int pidfd) {
    struct pollfd descriptor = { .fd = pidfd, .events = POLLIN };
    const int count = poll(&descriptor, 1, 0);
    if (count < 0) return -1;
    if ((descriptor.revents & (POLLERR | POLLNVAL)) != 0) { errno = EIO; return -1; }
    if ((descriptor.revents & ~(POLLIN | POLLHUP)) != 0) { errno = EPROTO; return -1; }
    return (descriptor.revents & (POLLIN | POLLHUP)) != 0;
}

struct observation {
    int dead;
    int absent;
    char state;
};

/* Shared by the old live/zombie controls and bridge mode. The caller polls its
 * pidfds FIRST, so proc reads cannot upgrade an initially live sample. PPID is
 * deliberately not an identity invariant here: guardian adoption is expected. */
static const char *observe(int proc, int dead, const struct identity *original,
                           struct observation *result) {
    struct identity current;
    int absent = 0;
    if (stat_identity(proc, original->pid, &current) != 0) {
        if (!gone(errno)) return "check-proc-visibility";
        absent = 1;
    } else if (current.start != original->start) {
        absent = 1; /* Reused PID is not the pinned process. No signal is sent. */
    } else {
        if (!same_process(original, &current)) { errno = ESTALE; return "check-identity-drift"; }
        const int owner = uid_matches(proc, original->pid, original->uid);
        if (owner < 0 && gone(errno)) absent = 1;
        else if (owner != 1) { if (owner == 0) errno = ESTALE; return "check-uid-visibility"; }
    }
    *result = (struct observation){ .dead = dead, .absent = absent,
        .state = absent ? '\0' : current.state };
    return NULL;
}

static int check(int proc, int pidfd, const struct identity *original) {
    const int dead = terminated(pidfd);
    if (dead < 0) return fail("pidfd-poll");
    struct observation result;
    const char *error = observe(proc, dead, original, &result);
    if (error != NULL) return fail(error);
    if (printf("{\"event\":\"check\",\"pidfdTerminated\":%s,\"originalIdentityAbsent\":%s,\"procState\":",
               dead ? "true" : "false", result.absent ? "true" : "false") < 0) return 1;
    if (result.absent) { if (printf("null}\n") < 0) return 1; }
    else if (printf("\"%c\"}\n", result.state) < 0) return 1;
    return fflush(stdout) == 0 ? 0 : 1;
}

struct bridge_command {
    char bytes[PROC_BYTES];
    size_t length;
};

struct bridge_identity {
    struct identity guardian;
    struct identity leader;
    struct identity connection;
};

static int same_held_process(const struct identity *a, const struct identity *b) {
    return same_process(a, b) && a->parent == b->parent && a->group == b->group;
}

static int live_owned(int proc, int pid, unsigned int uid, struct identity *result) {
    struct identity before, after;
    if (stat_identity(proc, pid, &before) != 0) return -1;
    const int owner = uid_matches(proc, pid, uid);
    if (owner != 1) { if (owner == 0) errno = EPERM; return -1; }
    if (stat_identity(proc, pid, &after) != 0) return -1;
    if (!same_held_process(&before, &after)) { errno = ESTALE; return -1; }
    const int owner_after = uid_matches(proc, pid, uid);
    if (owner_after != 1) { if (owner_after == 0) errno = ESTALE; return -1; }
    if (after.state == 'Z' || after.state == 'X' || after.state == 'x') {
        errno = ESRCH; return -1;
    }
    after.uid = uid;
    *result = after;
    return 0;
}

/* Opaque arguments are matched byte-for-byte, including all three final NULs.
 * The trusted caller owns their socat grammar; this oracle does not execute it.
 * Canonical pathname equality is not executable-content authentication. */
static int bridge_command(int argc, char **argv, struct bridge_command *result) {
    if (argc != 7 || argv[4][0] != '/' || strnlen(argv[4], PATH_MAX) >= PATH_MAX) return -1;
    char canonical[PATH_MAX];
    if (realpath(argv[4], canonical) == NULL || strcmp(canonical, argv[4]) != 0) return -1;
    result->length = 0;
    for (int i = 4; i < 7; ++i) {
        const size_t length = strnlen(argv[i], PROC_BYTES);
        if (length == 0 || length >= PROC_BYTES || length + 1 > PROC_BYTES - result->length)
            return -1;
        memcpy(result->bytes + result->length, argv[i], length + 1);
        result->length += length + 1;
    }
    return 0;
}

static int relay_identity(int proc, int pid, unsigned int uid, int parent, int group,
                          const struct bridge_command *command, struct identity *result) {
    struct identity before, after;
    if (live_owned(proc, pid, uid, &before) != 0) return -1;
    if (before.parent != parent || before.group != group || before.session != group) {
        errno = ESTALE; return -1;
    }
    char bytes[PROC_BYTES + 1];
    const ssize_t length = proc_bytes(proc, pid, "cmdline", bytes);
    if (length < 0) return -1;
    if ((size_t)length != command->length || memcmp(bytes, command->bytes, command->length) != 0) {
        errno = EPROTO; return -1;
    }
    if (live_owned(proc, pid, uid, &after) != 0) return -1;
    if (!same_held_process(&before, &after)) { errno = ESTALE; return -1; }
    *result = after;
    return 0;
}

/* Open a fresh directory description for EACH scan. F_DUPFD would share its
 * directory offset with the pinned proc fd and could hide later matches.
 * Any direct child that is not the exact expected live relay fails closed. */
static int relay_child(int proc, int parent, unsigned int uid, int leader,
                       const struct bridge_command *command, struct identity *result) {
    const int fresh = openat(proc, ".", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (fresh < 0) return -1;
    DIR *directory = fdopendir(fresh);
    if (directory == NULL) { const int saved = errno; close(fresh); errno = saved; return -1; }
    unsigned int entries = 0, matches = 0;
    int error = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (entry == NULL) { error = errno; break; }
        if (++entries > MAX_ENTRIES) { error = EOVERFLOW; break; }
        if (entry->d_name[0] < '0' || entry->d_name[0] > '9') continue;
        uint64_t pid;
        if (decimal(entry->d_name, INT_MAX, &pid) != 0 || pid == 0) { error = EPROTO; break; }
        struct identity candidate;
        if (stat_identity(proc, (int)pid, &candidate) != 0) {
            if (gone(errno)) continue; /* An unrelated process can disappear. */
            error = errno; break;
        }
        if (candidate.parent != parent) continue;
        const int group = leader == 0 ? (int)pid : leader;
        struct identity matched;
        if (relay_identity(proc, (int)pid, uid, parent, group, command, &matched) != 0) {
            error = errno; break;
        }
        if (!same_held_process(&candidate, &matched)) { error = ESTALE; break; }
        if (++matches > 1) { error = EEXIST; break; }
        *result = matched;
    }
    if (closedir(directory) != 0 && error == 0) error = errno;
    if (error == 0 && matches != 1) error = ESRCH;
    if (error != 0) { errno = error; return -1; }
    return 0;
}

static int bridge_topology(int proc, int guardian, unsigned int uid,
                           const struct bridge_command *command, struct bridge_identity *result) {
    struct bridge_identity before, after;
    if (live_owned(proc, guardian, uid, &before.guardian) != 0 ||
        relay_child(proc, guardian, uid, 0, command, &before.leader) != 0 ||
        relay_child(proc, before.leader.pid, uid, before.leader.pid, command,
                    &before.connection) != 0) return -1;
    if (before.leader.pid == guardian || before.connection.pid == guardian ||
        before.connection.pid == before.leader.pid) { errno = ESTALE; return -1; }
    if (live_owned(proc, guardian, uid, &after.guardian) != 0 ||
        relay_identity(proc, before.leader.pid, uid, guardian, before.leader.pid,
                       command, &after.leader) != 0 ||
        relay_identity(proc, before.connection.pid, uid, before.leader.pid, before.leader.pid,
                       command, &after.connection) != 0) return -1;
    if (!same_held_process(&before.guardian, &after.guardian) ||
        !same_held_process(&before.leader, &after.leader) ||
        !same_held_process(&before.connection, &after.connection)) { errno = ESTALE; return -1; }
    *result = after;
    return 0;
}

static int print_bridge_identity(const struct identity *identity) {
    return printf("{\"pid\":%d,\"uid\":%u,\"startTime\":\"%" PRIu64
                  "\",\"session\":%d,\"state\":\"%c\",\"pidfdTerminated\":false,\"parent\":%d,\"group\":%d}",
                  identity->pid, identity->uid, identity->start, identity->session,
                  identity->state, identity->parent, identity->group) < 0 ? -1 : 0;
}

static int print_observation(const struct observation *result) {
    if (printf("{\"pidfdTerminated\":%s,\"originalIdentityAbsent\":%s,\"procState\":",
               result->dead ? "true" : "false", result->absent ? "true" : "false") < 0) return -1;
    if (result->absent) return printf("null}") < 0 ? -1 : 0;
    return printf("\"%c\"}", result->state) < 0 ? -1 : 0;
}

static int bridge_check(int proc, const int pidfds[3], const struct bridge_identity *original) {
    /* Both zero-time pidfd samples precede either proc read. There is no wait for
     * death and no later poll that could manufacture an improved observation. */
    const int leader_dead = terminated(pidfds[1]);
    const int connection_dead = terminated(pidfds[2]);
    if (leader_dead < 0 || connection_dead < 0) return fail("pidfd-poll");
    struct observation leader, connection;
    const char *error = observe(proc, leader_dead, &original->leader, &leader);
    if (error == NULL) error = observe(proc, connection_dead, &original->connection, &connection);
    if (error != NULL) return fail(error);
    if (printf("{\"event\":\"bridge-check\",\"leader\":") < 0 || print_observation(&leader) != 0 ||
        printf(",\"connection\":") < 0 || print_observation(&connection) != 0 ||
        printf("}\n") < 0 || fflush(stdout) != 0) return 1;
    return 0;
}

static int bridge_loop(int proc, int guardian, unsigned int uid, const struct bridge_command *command) {
    int pidfds[3] = {-1, -1, -1}, result = 0, ready = 0;
    struct bridge_identity original;
    for (unsigned int commands = 0; commands < 16; ++commands) {
        char line[16];
        size_t count = 0;
        int byte;
        while ((byte = fgetc(stdin)) != EOF && byte != '\n') {
            if (byte == 0 || count + 2 >= sizeof(line)) { errno = EPROTO; result = fail("stdin-command"); break; }
            line[count++] = (char)byte;
        }
        if (result != 0) break;
        if (byte == EOF) {
            if (ferror(stdin)) result = fail("stdin-read");
            else if (count != 0) { errno = EPROTO; result = fail("stdin-command"); }
            break;
        }
        line[count++] = '\n';
        line[count] = '\0';
        if (strcmp(line, "quit\n") == 0) break;
        if (strcmp(line, "ready\n") == 0 && !ready) {
            if (bridge_topology(proc, guardian, uid, command, &original) != 0) {
                result = fail("bridge-discovery"); break;
            }
            const int pids[3] = {guardian, original.leader.pid, original.connection.pid};
            for (int i = 0; i < 3; ++i) {
                pidfds[i] = (int)syscall(SYS_pidfd_open, pids[i], 0);
                if (pidfds[i] < 0) { result = fail("pidfd-open"); break; }
            }
            if (result != 0) break;
            struct bridge_identity after;
            if (bridge_topology(proc, guardian, uid, command, &after) != 0 ||
                !same_held_process(&original.guardian, &after.guardian) ||
                !same_held_process(&original.leader, &after.leader) ||
                !same_held_process(&original.connection, &after.connection) ||
                terminated(pidfds[0]) != 0 || terminated(pidfds[1]) != 0 || terminated(pidfds[2]) != 0) {
                result = fail("ready-acquisition-race"); break;
            }
            original = after;
            ready = 1;
            if (printf("{\"event\":\"bridge-ready\",\"leader\":") < 0 ||
                print_bridge_identity(&original.leader) != 0 || printf(",\"connection\":") < 0 ||
                print_bridge_identity(&original.connection) != 0 || printf("}\n") < 0 ||
                fflush(stdout) != 0) { result = 1; break; }
        } else if (strcmp(line, "check\n") == 0 && ready) {
            result = bridge_check(proc, pidfds, &original);
            if (result != 0) break;
        } else { errno = EPROTO; result = fail("stdin-command"); break; }
        if (commands == 15) { errno = EOVERFLOW; result = fail("command-limit"); }
    }
    for (int i = 0; i < 3; ++i)
        if (pidfds[i] >= 0 && close(pidfds[i]) != 0) result = 1;
    return result;
}

int main(int argc, char **argv) {
    /* Only the oracle itself is timed out; discovered processes are never signalled. */
    struct sigaction timeout_action = { .sa_handler = SIG_DFL };
    sigset_t timeout_mask;
    if (sigemptyset(&timeout_action.sa_mask) != 0 ||
        sigaction(SIGALRM, &timeout_action, NULL) != 0 ||
        sigemptyset(&timeout_mask) != 0 || sigaddset(&timeout_mask, SIGALRM) != 0 ||
        sigprocmask(SIG_UNBLOCK, &timeout_mask, NULL) != 0) return 1;
    alarm(10);
    int known = 0, bridge = 0;
    uint64_t pid = 0, uid;
    const char *uid_text, *marker = NULL;
    struct bridge_command command;
    if (argc == 4 && strcmp(argv[1], "discover") == 0) {
        uid_text = argv[2]; marker = argv[3];
    } else if (argc == 5 && strcmp(argv[1], "known") == 0) {
        known = 1;
        if (decimal(argv[2], INT_MAX, &pid) != 0 || pid == 0) return 2;
        uid_text = argv[3]; marker = argv[4];
    } else if (argc == 7 && strcmp(argv[1], "bridge") == 0) {
        bridge = 1;
        if (decimal(argv[2], INT_MAX, &pid) != 0 || pid == 0 || bridge_command(argc, argv, &command) != 0)
            return 2;
        uid_text = argv[3];
    } else return 2;
    if (decimal(uid_text, UINT_MAX, &uid) != 0) return 2;
    if (!bridge) {
        if (strlen(marker) != 64) return 2;
        for (unsigned int i = 0; i < 64; ++i)
            if (!((marker[i] >= '0' && marker[i] <= '9') || (marker[i] >= 'a' && marker[i] <= 'f'))) return 2;
    }
    const int proc = open("/proc", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (proc < 0) return fail("proc-open");
    struct statfs filesystem;
    if (fstatfs(proc, &filesystem) != 0 || filesystem.f_type != PROC_SUPER_MAGIC)
        return fail("proc-filesystem");
    if (bridge) {
        const int result = bridge_loop(proc, (int)pid, (unsigned int)uid, &command);
        return close(proc) == 0 ? result : 1;
    }
    int pidfd = -1, result = 0;
    struct identity original = {0};
    for (unsigned int commands = 0; commands < 16; ++commands) {
        char line[16];
        if (fgets(line, sizeof(line), stdin) == NULL) {
            if (ferror(stdin)) result = fail("stdin-read");
            break;
        }
        if (strcmp(line, "quit\n") == 0) break;
        if (strcmp(line, "ready\n") == 0 && pidfd == -1) {
            const int found = known ? match(proc, (int)pid, (unsigned int)uid, marker, &original)
                : (discover(proc, (unsigned int)uid, marker, &original) == 0 ? 1 : -1);
            if (found != 1) { if (found == 0) errno = ESRCH; result = fail("ready-discovery"); break; }
            pidfd = (int)syscall(SYS_pidfd_open, original.pid, 0);
            if (pidfd < 0) { result = fail("pidfd-open"); break; }
            struct identity after;
            if (match(proc, original.pid, (unsigned int)uid, marker, &after) != 1 ||
                !same_process(&original, &after) || terminated(pidfd) != 0) {
                result = fail("ready-acquisition-race"); break;
            }
            original = after;
            if (printf("{\"event\":\"ready\",\"pid\":%d,\"uid\":%u,\"startTime\":\"%" PRIu64
                       "\",\"session\":%d,\"state\":\"%c\",\"pidfdTerminated\":false}\n",
                       original.pid, original.uid, original.start, original.session, original.state) < 0 ||
                fflush(stdout) != 0) { result = 1; break; }
        } else if (strcmp(line, "check\n") == 0 && pidfd >= 0) {
            result = check(proc, pidfd, &original);
            if (result != 0) break;
        } else { errno = EPROTO; result = fail("stdin-command"); break; }
        if (commands == 15) { errno = EOVERFLOW; result = fail("command-limit"); }
    }
    if (pidfd >= 0 && close(pidfd) != 0) result = 1;
    if (close(proc) != 0) result = 1;
    return result;
}
