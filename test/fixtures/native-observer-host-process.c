/* Host-only TEST oracle. Never receives a candidate-reported PID and never
 * signals a discovered process. Run outside the candidate sandbox:
 *   probe discover UID MARKER
 *   probe known HOST_OWNED_PID UID MARKER
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
    int session = 0;
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
        if (field == 6 || field == 22) {
            uint64_t value;
            if (decimal(token, field == 6 ? INT_MAX : UINT64_MAX, &value) != 0) {
                errno = EPROTO; return -1;
            }
            if (field == 6) session = (int)value;
            else start = value;
        }
        if (field < 22 && *cursor != ' ') { errno = EPROTO; return -1; }
        while (*cursor == ' ') ++cursor;
    }
    *result = (struct identity){ .pid = pid, .start = start, .session = session, .state = state };
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

static int check(int proc, int pidfd, const struct identity *original) {
    /* Poll FIRST: do not upgrade an initially live result after reading proc. */
    const int dead = terminated(pidfd);
    if (dead < 0) return fail("pidfd-poll");
    struct identity current;
    int absent = 0;
    if (stat_identity(proc, original->pid, &current) != 0) {
        if (!gone(errno)) return fail("check-proc-visibility");
        absent = 1;
    } else if (current.start != original->start) {
        absent = 1; /* Reused PID is not the pinned process. No signal is sent. */
    } else {
        if (!same_process(original, &current)) { errno = ESTALE; return fail("check-identity-drift"); }
        const int owner = uid_matches(proc, original->pid, original->uid);
        if (owner < 0 && gone(errno)) absent = 1;
        else if (owner != 1) { if (owner == 0) errno = ESTALE; return fail("check-uid-visibility"); }
    }
    if (printf("{\"event\":\"check\",\"pidfdTerminated\":%s,\"originalIdentityAbsent\":%s,\"procState\":",
               dead ? "true" : "false", absent ? "true" : "false") < 0) return 1;
    if (absent) { if (printf("null}\n") < 0) return 1; }
    else if (printf("\"%c\"}\n", current.state) < 0) return 1;
    return fflush(stdout) == 0 ? 0 : 1;
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
    int known = 0;
    uint64_t pid = 0, uid;
    const char *uid_text, *marker;
    if (argc == 4 && strcmp(argv[1], "discover") == 0) {
        uid_text = argv[2]; marker = argv[3];
    } else if (argc == 5 && strcmp(argv[1], "known") == 0) {
        known = 1;
        if (decimal(argv[2], INT_MAX, &pid) != 0 || pid == 0) return 2;
        uid_text = argv[3]; marker = argv[4];
    } else return 2;
    if (decimal(uid_text, UINT_MAX, &uid) != 0 || strlen(marker) != 64) return 2;
    for (unsigned int i = 0; i < 64; ++i)
        if (!((marker[i] >= '0' && marker[i] <= '9') || (marker[i] >= 'a' && marker[i] <= 'f'))) return 2;
    const int proc = open("/proc", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    if (proc < 0) return fail("proc-open");
    struct statfs filesystem;
    if (fstatfs(proc, &filesystem) != 0 || filesystem.f_type != PROC_SUPER_MAGIC)
        return fail("proc-filesystem");
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
