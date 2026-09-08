/* Test-only socket/identity observation inside the existing PID1 witness.
 * No helper child, numeric-PID pidfd fallback, or process signaling.
 */
#include <sys/socket.h>
#include <sys/un.h>

/* Linux v6.8 include/uapi/asm-generic/socket.h; kernel binds this handle to
 * sk_peer_pid, not a fresh numeric PID lookup. Unsupported kernels fail closed. */
#ifndef SO_PEERPIDFD
#define SO_PEERPIDFD 77
#endif

struct resistance_observation {
    int listener, connection, pidfd, ready, closed, term, live_after_term, terminated;
};

struct resistance_identity {
    long parent, group, session;
    unsigned long long start;
};

static ssize_t resistance_proc(pid_t pid, const char *name, char bytes[4097]) {
    char path[64];
    const int length = snprintf(path, sizeof(path), "/proc/%ld/%s", (long)pid, name);
    if (length <= 0 || (size_t)length >= sizeof(path)) return -1;
    const int fd = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (fd < 0) return -1;
    size_t used = 0;
    for (;;) {
        const ssize_t count = read(fd, bytes + used, 4097 - used);
        if (count < 0 && errno == EINTR) continue;
        if (count < 0) { close(fd); return -1; }
        if (count == 0) break;
        used += (size_t)count;
        if (used > 4096) { close(fd); return -1; }
    }
    if (close(fd) != 0) return -1;
    bytes[used] = '\0';
    return (ssize_t)used;
}

static int resistance_identity(pid_t pid, struct resistance_identity *identity) {
    char bytes[4097];
    ssize_t count = resistance_proc(pid, "stat", bytes);
    if (count <= 0 || memchr(bytes, '\0', (size_t)count) != NULL) return -1;
    char *end;
    errno = 0;
    const long parsed = strtol(bytes, &end, 10);
    if (errno != 0 || parsed != pid || strncmp(end, " (", 2) != 0) return -1;
    char *tail = strrchr(end, ')');
    if (tail == NULL || strlen(tail) < 5 || tail[1] != ' ' || tail[3] != ' ' ||
        strchr("RSDTtKWPIN", tail[2]) == NULL) return -1;
    char *cursor = tail + 4;
    for (int field = 4; field <= 22; ++field) {
        end = strchr(cursor, ' ');
        if (end == NULL || end == cursor) return -1;
        if (field == 4 || field == 5 || field == 6 || field == 22) {
            if (*cursor < '0' || *cursor > '9') return -1;
            errno = 0;
            char *parsed_end;
            const unsigned long long value = strtoull(cursor, &parsed_end, 10);
            if (errno != 0 || parsed_end != end || (field != 22 && value > INT_MAX)) return -1;
            if (field == 4) identity->parent = (long)value;
            if (field == 5) identity->group = (long)value;
            if (field == 6) identity->session = (long)value;
            if (field == 22) identity->start = value;
        }
        cursor = end + 1;
    }
    count = resistance_proc(pid, "status", bytes);
    if (count <= 0 || memchr(bytes, '\0', (size_t)count) != NULL) return -1;
    const char *uid = strstr(bytes, "\nUid:\t");
    unsigned long ids[4];
    int consumed = 0;
    if (uid == NULL || sscanf(uid, "\nUid:\t%lu\t%lu\t%lu\t%lu%n",
        &ids[0], &ids[1], &ids[2], &ids[3], &consumed) != 4 || uid[consumed] != '\n') return -1;
    for (int i = 0; i < 4; ++i) if (ids[i] != getuid()) return -1;
    return 0;
}

static int resistance_argv(pid_t pid, char **argv) {
    char bytes[4097];
    const ssize_t count = resistance_proc(pid, "cmdline", bytes);
    if (count <= 0) return -1;
    size_t used = 0;
    for (int i = 3; i <= 5; ++i) {
        const size_t length = strlen(argv[i]) + 1;
        if (length > (size_t)count - used || memcmp(bytes + used, argv[i], length) != 0) return -1;
        used += length;
    }
    return used == (size_t)count ? 0 : -1;
}

static int resistance_same(const struct resistance_identity *a,
                           const struct resistance_identity *b) {
    return a->parent == b->parent && a->group == b->group && a->session == b->session &&
        a->start == b->start;
}

/* One zero-time kernel sample; interrupted or unexpected events fail, no retry. */
static int resistance_terminated(int pidfd) {
    struct pollfd handle = { .fd = pidfd, .events = POLLIN };
    const int result = poll(&handle, 1, 0);
    if (result < 0 || (handle.revents & ~(POLLIN | POLLHUP)) != 0) return -1;
    return (handle.revents & POLLIN) != 0 ? 1 : result == 0 ? 0 : -1;
}

static int resistance_listen(const char *argument) {
    const char prefix[] = "UNIX-LISTEN:", suffix[] = ",fork,reuseaddr";
    const size_t length = strlen(argument);
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    if (length <= sizeof(prefix) - 1 + sizeof(suffix) - 1 ||
        strncmp(argument, prefix, sizeof(prefix) - 1) != 0 ||
        strcmp(argument + length - (sizeof(suffix) - 1), suffix) != 0) return -1;
    const size_t path_length = length - (sizeof(prefix) - 1) - (sizeof(suffix) - 1);
    if (path_length >= sizeof(address.sun_path)) return -1;
    memcpy(address.sun_path, argument + sizeof(prefix) - 1, path_length);
    address.sun_family = AF_UNIX;
    const int listener = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
    if (listener < 0) return -1;
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) != 0 ||
        listen(listener, 1) != 0) { close(listener); return -1; }
    return listener;
}

static int resistance_accept(struct resistance_observation *observation, pid_t owner, char **argv) {
    const int connection = accept4(observation->listener, NULL, NULL, SOCK_CLOEXEC | SOCK_NONBLOCK);
    if (connection < 0) return errno == EAGAIN || errno == EINTR ? 0 : -1;
    if (observation->connection != -1) { close(connection); return -1; }
    observation->connection = connection;
    struct ucred peer;
    socklen_t size = sizeof(peer);
    if (getsockopt(connection, SOL_SOCKET, SO_PEERCRED, &peer, &size) != 0 ||
        size != sizeof(peer) || peer.pid <= 1 || peer.uid != getuid() || peer.gid != getgid()) return -1;
    size = sizeof(observation->pidfd);
    if (getsockopt(connection, SOL_SOCKET, SO_PEERPIDFD, &observation->pidfd, &size) != 0 ||
        size != sizeof(observation->pidfd) || observation->pidfd < 0 ||
        fcntl(observation->pidfd, F_SETFD, FD_CLOEXEC) != 0 ||
        resistance_terminated(observation->pidfd) != 0) return -1;
    struct resistance_identity child, leader, guardian, child_after, leader_after, guardian_after;
    if (resistance_identity(peer.pid, &child) != 0 || child.parent <= 1 ||
        resistance_identity((pid_t)child.parent, &leader) != 0 ||
        resistance_identity(owner, &guardian) != 0 || guardian.parent != 1 ||
        leader.parent != owner || leader.group != child.parent || leader.session != child.parent ||
        child.group != leader.group || child.session != leader.session ||
        resistance_argv(peer.pid, argv) != 0 || resistance_argv((pid_t)child.parent, argv) != 0 ||
        resistance_identity(peer.pid, &child_after) != 0 ||
        resistance_identity((pid_t)child.parent, &leader_after) != 0 ||
        resistance_identity(owner, &guardian_after) != 0 ||
        !resistance_same(&child, &child_after) || !resistance_same(&leader, &leader_after) ||
        !resistance_same(&guardian, &guardian_after) ||
        resistance_argv(peer.pid, argv) != 0 || resistance_argv((pid_t)child.parent, argv) != 0 ||
        resistance_terminated(observation->pidfd) != 0) return -1;
    return 0;
}

static int resistance_read(struct resistance_observation *observation, int control_closed) {
    if (observation->connection < 0 || observation->closed) return 0;
    unsigned char bytes[2];
    const ssize_t count = recv(observation->connection, bytes, sizeof(bytes), MSG_TRUNC);
    if (count < 0) return errno == EAGAIN || errno == EINTR ? 0 : -1;
    if (count == 0) {
        if (!observation->ready || !control_closed) return -1;
        observation->closed = 1;
        return 0;
    }
    if (count != 1) return -1;
    if (!observation->ready) {
        if (bytes[0] != 'R' || control_closed) return -1;
        observation->ready = 1;
        return 0;
    }
    if (bytes[0] != 'T' || !control_closed || observation->term) return -1;
    const int terminated = resistance_terminated(observation->pidfd);
    if (terminated < 0) return -1;
    observation->term = 1;
    observation->live_after_term = !terminated;
    return 0;
}
