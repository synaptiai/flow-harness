/* Observer-only development owner for one admitted, fixed socat bridge.
 * This is NOT containment for arbitrary programs. The admitted relay must keep
 * its process group and ancestry. Loss of this owner means unconfirmed cleanup.
 * Path checks below do not establish executable or environment custody.
 *
 * CLI: guardian ABSOLUTE_RELAY UNIX-LISTEN:PATH,fork,reuseaddr
 *               TCP:localhost:PORT,keepalive,keepidle=10,keepintvl=5,keepcnt=3
 * stdin: exactly stop\n followed by EOF. stdout: OWNED, then SETTLED only after
 * explicit release and complete reaping. OWNED is not listener readiness.
 */
#define _GNU_SOURCE
#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error "The host bridge guardian requires Linux x64"
#endif

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

extern char **environ;
static volatile sig_atomic_t interrupted;
enum { STARTUP_MS = 1000, TERM_GRACE_MS = 1500, JOIN_MS = 1000 };

static void interrupt_owner(int number) {
    if (interrupted == 0) interrupted = number;
}

static int64_t monotonic_ms(void) {
    struct timespec now;
    if (clock_gettime(CLOCK_MONOTONIC, &now) != 0 || now.tv_sec < 0 ||
        now.tv_sec > (INT64_MAX - 10000) / 1000) return -1;
    return (int64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000;
}

static int64_t deadline_after(int milliseconds) {
    const int64_t now = monotonic_ms();
    return now < 0 ? -1 : now + milliseconds;
}

/* A timeout is failure, never an implicit successful ownership transition. */
static int wait_ready(int fd, short events, int64_t deadline, int cancellable) {
    for (;;) {
        if (cancellable && interrupted) { errno = EINTR; return -1; }
        const int64_t now = monotonic_ms();
        if (now < 0) return -1;
        if (deadline < 0 || now >= deadline) { errno = ETIMEDOUT; return -1; }
        const int64_t left = deadline - now;
        struct pollfd item = {.fd = fd, .events = events};
        const int result = poll(&item, 1, left > INT_MAX ? INT_MAX : (int)left);
        if (result < 0 && errno == EINTR) continue;
        if (result <= 0) { if (result == 0) errno = ETIMEDOUT; return -1; }
        if (item.revents & POLLNVAL) { errno = EBADF; return -1; }
        if (item.revents & (events | POLLHUP | POLLERR)) return 0;
    }
}

static int write_bounded(int fd, const void *bytes, size_t length, int64_t deadline) {
    const unsigned char *cursor = bytes;
    while (length != 0) {
        if (interrupted) { errno = EINTR; return -1; }
        const int64_t now = monotonic_ms();
        if (now < 0 || deadline < 0 || now >= deadline) { errno = ETIMEDOUT; return -1; }
        const ssize_t written = write(fd, cursor, length);
        if (written > 0) { cursor += written; length -= (size_t)written; continue; }
        if (written < 0 && errno == EINTR) continue;
        if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
            if (wait_ready(fd, POLLOUT, deadline, 1) == 0) continue;
        }
        if (written == 0) errno = EIO;
        return -1;
    }
    return 0;
}

static ssize_t read_bounded(int fd, void *bytes, size_t length, int64_t deadline) {
    for (;;) {
        if (interrupted) { errno = EINTR; return -1; }
        const int64_t now = monotonic_ms();
        if (now < 0 || deadline < 0 || now >= deadline) { errno = ETIMEDOUT; return -1; }
        const ssize_t count = read(fd, bytes, length);
        if (count >= 0) return count;
        if (errno == EINTR) continue;
        if ((errno == EAGAIN || errno == EWOULDBLOCK) &&
            wait_ready(fd, POLLIN, deadline, 1) == 0) continue;
        return -1;
    }
}

static int nonblocking_stream(int fd, int writing) {
    struct stat metadata;
    const int flags = fcntl(fd, F_GETFL);
    if (flags < 0 || fstat(fd, &metadata) != 0 ||
        (!S_ISFIFO(metadata.st_mode) && !S_ISSOCK(metadata.st_mode)) ||
        (flags & O_PATH) != 0 ||
        (writing ? (flags & O_ACCMODE) == O_RDONLY : (flags & O_ACCMODE) == O_WRONLY)) return -1;
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

/* Raw Linux x64 ABI includes the signals glibc reserves for threading. */
struct kernel_action { uint64_t handler, flags, restorer, mask; };
_Static_assert(sizeof(struct kernel_action) == 32, "Unexpected signal-action ABI");
static int reset_signals(void) {
    const struct kernel_action action = {0, 0, 0, 0};
    for (int number = 1; number <= 64; ++number) {
        if (number == SIGKILL || number == SIGSTOP) continue;
        if (syscall(SYS_rt_sigaction, number, &action, NULL, sizeof(uint64_t)) != 0) return -1;
    }
    const uint64_t empty = 0;
    return syscall(SYS_rt_sigprocmask, SIG_SETMASK, &empty, NULL, sizeof(empty)) == 0 ? 0 : -1;
}

static int owner_signals(void) {
    if (reset_signals() != 0) return -1;
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    if (sigemptyset(&action.sa_mask) != 0) return -1;
    action.sa_handler = interrupt_owner;
    const int numbers[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT};
    for (size_t i = 0; i < sizeof(numbers) / sizeof(numbers[0]); ++i)
        if (sigaction(numbers[i], &action, NULL) != 0) return -1;
    action.sa_handler = SIG_IGN;
    return sigaction(SIGPIPE, &action, NULL);
}

static int single_threaded_subreaper(void) {
    DIR *tasks = opendir("/proc/self/task");
    if (tasks == NULL) return -1;
    unsigned int count = 0;
    int failed = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(tasks);
        if (entry == NULL) { if (errno != 0) failed = 1; break; }
        if (entry->d_name[0] == '.') continue;
        if (++count > 1) { failed = 1; break; }
    }
    if (closedir(tasks) != 0 || count != 1 || failed) return -1;
    int actual = 0;
    if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0 ||
        prctl(PR_GET_CHILD_SUBREAPER, &actual) != 0 || actual != 1) return -1;
    return 0;
}

static int valid_arguments(int argc, char **argv) {
    if (argc != 4 || argv[1][0] != '/' || strnlen(argv[1], PATH_MAX) >= PATH_MAX) return 0;
    char canonical[PATH_MAX];
    if (realpath(argv[1], canonical) == NULL || strcmp(canonical, argv[1]) != 0) return 0;
    struct stat executable;
    if (stat(canonical, &executable) != 0 || !S_ISREG(executable.st_mode) ||
        access(canonical, X_OK) != 0) return 0;
    static const char unix_prefix[] = "UNIX-LISTEN:";
    static const char unix_suffix[] = ",fork,reuseaddr";
    const size_t unix_length = strnlen(argv[2], 256);
    const size_t prefix = sizeof(unix_prefix) - 1, suffix = sizeof(unix_suffix) - 1;
    if (unix_length >= 256 || unix_length <= prefix + suffix ||
        memcmp(argv[2], unix_prefix, prefix) != 0 ||
        memcmp(argv[2] + unix_length - suffix, unix_suffix, suffix) != 0) return 0;
    const size_t path_length = unix_length - prefix - suffix;
    if (argv[2][prefix] != '/' || path_length >= sizeof(((struct sockaddr_un *)0)->sun_path)) return 0;
    for (size_t i = prefix; i < unix_length - suffix; ++i) {
        const unsigned char c = (unsigned char)argv[2][i];
        if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
              (c >= '0' && c <= '9') || c == '/' || c == '.' || c == '_' || c == '-')) return 0;
    }
    static const char tcp_prefix[] = "TCP:localhost:";
    static const char tcp_suffix[] = ",keepalive,keepidle=10,keepintvl=5,keepcnt=3";
    if (strncmp(argv[3], tcp_prefix, sizeof(tcp_prefix) - 1) != 0) return 0;
    const char *port = argv[3] + sizeof(tcp_prefix) - 1;
    if (*port < '1' || *port > '9') return 0;
    unsigned int value = 0, digits = 0;
    while (*port >= '0' && *port <= '9') {
        if (++digits > 5) return 0;
        value = value * 10 + (unsigned int)(*port++ - '0');
    }
    return value <= 65535 && strcmp(port, tcp_suffix) == 0;
}

/* Error reporting is explicit; a broken error channel cannot return normally. */
__attribute__((noreturn))
static void child_error(int writer, int error) {
    const uint32_t number = error > 0 && error <= 4095 ? (uint32_t)error : EIO;
    const unsigned char record[5] = {'E', (unsigned char)number,
        (unsigned char)(number >> 8), (unsigned char)(number >> 16), (unsigned char)(number >> 24)};
    if (write(writer, record, sizeof(record)) != (ssize_t)sizeof(record)) {
        const pid_t own = (pid_t)syscall(SYS_getpid);
        if (own > 1) (void)syscall(SYS_kill, own, SIGKILL);
        for (;;) __asm__ volatile("ud2");
    }
    _exit(125);
}

__attribute__((noreturn))
static void child_main(int report[2], int acknowledgement[2], char **argv, int64_t deadline) {
    if (close(report[0]) != 0 || close(acknowledgement[1]) != 0 || reset_signals() != 0)
        child_error(report[1], errno);
    interrupted = 0;
    const pid_t own = getpid();
    if (own <= 1 || setsid() != own || getpgrp() != own || getsid(0) != own)
        child_error(report[1], errno);
    const int null_fd = open("/dev/null", O_RDWR | O_CLOEXEC | O_NOFOLLOW);
    struct stat null_metadata;
    if (null_fd < 0 || fstat(null_fd, &null_metadata) != 0 || !S_ISCHR(null_metadata.st_mode))
        child_error(report[1], errno);
    for (int fd = 0; fd <= 2; ++fd)
        if (dup2(null_fd, fd) != fd) child_error(report[1], errno);
    if (close(null_fd) != 0 || write_bounded(report[1], "G", 1, deadline) != 0)
        child_error(report[1], errno);
    unsigned char ack;
    if (read_bounded(acknowledgement[0], &ack, 1, deadline) != 1 || ack != 'A')
        child_error(report[1], EPROTO);
    if (close(acknowledgement[0]) != 0) child_error(report[1], errno);
    /* Both pipes are CLOEXEC; only /dev/null stdio reaches the admitted relay. */
    execve(argv[1], &argv[1], environ);
    child_error(report[1], errno);
}

/* WNOWAIT pins the actual direct child's PID through the last group signal. */
static int leader_state(pid_t leader, int *exited) {
    siginfo_t information;
    memset(&information, 0, sizeof(information));
    int result;
    do { result = waitid(P_PID, (id_t)leader, &information, WEXITED | WNOHANG | WNOWAIT); }
    while (result < 0 && errno == EINTR);
    if (result != 0) return -1;
    if (information.si_pid != 0 && information.si_pid != leader) { errno = ECHILD; return -1; }
    *exited = information.si_pid == leader;
    return 0;
}

static int signal_owned(pid_t leader, int group, int number) {
    int exited;
    if (leader_state(leader, &exited) != 0) return -1;
    if (group && (getpgid(leader) != leader || getsid(leader) != leader)) return -1;
    if (kill(group ? -leader : leader, number) != 0 && errno != ESRCH) return -1;
    return 0;
}

static int settle_owned(pid_t leader, int group) {
    int failed = signal_owned(leader, group, SIGTERM) != 0;
    const int64_t grace = deadline_after(TERM_GRACE_MS);
    for (;;) {
        int exited;
        if (leader_state(leader, &exited) != 0) { failed = 1; break; }
        if (!group && exited) break; /* No exec permission was granted. */
        const int64_t now = monotonic_ms();
        if (now < 0 || grace < 0) { failed = 1; break; }
        if (now >= grace) break;
        const int pause_ms = grace - now > 20 ? 20 : (int)(grace - now);
        if (poll(NULL, 0, pause_ms) < 0 && errno != EINTR) { failed = 1; break; }
    }
    if (signal_owned(leader, group, SIGKILL) != 0) failed = 1;
    /* No numeric group signal occurs after this point, including on failures.
     * Reaping can now release/reuse the leader PID without targeting strangers. */
    const int64_t join_deadline = deadline_after(JOIN_MS);
    for (;;) {
        const int64_t now = monotonic_ms();
        if (now < 0 || join_deadline < 0 || now >= join_deadline) return -1;
        int status;
        const pid_t reaped = waitpid(-1, &status, WNOHANG);
        if (reaped > 0) continue;
        if (reaped < 0) {
            if (errno == EINTR) continue;
            return errno == ECHILD && !failed ? 0 : -1;
        }
        const int pause_ms = join_deadline - now > 10 ? 10 : (int)(join_deadline - now);
        if (poll(NULL, 0, pause_ms) < 0 && errno != EINTR) return -1;
    }
}

static int await_release(pid_t leader) {
    unsigned char control[6];
    size_t length = 0;
    for (;;) {
        if (interrupted) return -1;
        int exited;
        if (leader_state(leader, &exited) != 0 || exited) return -1;
        const ssize_t count = read(STDIN_FILENO, control + length, sizeof(control) - length);
        if (count > 0) {
            length += (size_t)count;
            if (length > 5 || memcmp(control, "stop\n", length) != 0) return -1;
            continue;
        }
        if (count == 0) return length == 5 && !interrupted ? 0 : -1;
        if (errno == EINTR) continue;
        if (errno != EAGAIN && errno != EWOULDBLOCK) return -1;
        struct pollfd input = {.fd = STDIN_FILENO, .events = POLLIN};
        const int polled = poll(&input, 1, 20);
        if (polled < 0 && errno != EINTR) return -1;
        if (polled > 0 && (input.revents & POLLNVAL)) return -1;
    }
}

int main(int argc, char **argv) {
    const int64_t startup = deadline_after(STARTUP_MS);
    if (startup < 0 || !valid_arguments(argc, argv) || owner_signals() != 0 ||
        nonblocking_stream(STDIN_FILENO, 0) != 0 || nonblocking_stream(STDOUT_FILENO, 1) != 0 ||
        fcntl(STDERR_FILENO, F_GETFD) < 0 ||
        single_threaded_subreaper() != 0 || syscall(SYS_close_range, 3u, UINT_MAX, 0u) != 0) return 1;
    if (interrupted) return 1;
    int report[2], acknowledgement[2];
    if (pipe2(report, O_CLOEXEC | O_NONBLOCK) != 0) return 1;
    if (pipe2(acknowledgement, O_CLOEXEC | O_NONBLOCK) != 0) {
        (void)close(report[0]); (void)close(report[1]); return 1;
    }
    const int64_t before_fork = monotonic_ms();
    if (before_fork < 0 || before_fork >= startup || interrupted) {
        for (int i = 0; i < 2; ++i) { (void)close(report[i]); (void)close(acknowledgement[i]); }
        return 1;
    }
    const pid_t leader = fork();
    if (leader < 0) {
        for (int i = 0; i < 2; ++i) { (void)close(report[i]); (void)close(acknowledgement[i]); }
        return 1;
    }
    if (leader == 0) child_main(report, acknowledgement, argv, startup);
    int failed = 0, group = 0;
    if (close(report[1]) != 0) failed = 1;
    if (close(acknowledgement[0]) != 0) failed = 1;
    unsigned char first;
    if (!failed && read_bounded(report[0], &first, 1, startup) == 1 && first == 'G' &&
        getpgid(leader) == leader && getsid(leader) == leader) {
        group = 1; /* Establish ownership BEFORE permission to exec/fork. */
        if (write_bounded(acknowledgement[1], "A", 1, startup) != 0) failed = 1;
    } else failed = 1;
    if (close(acknowledgement[1]) != 0) failed = 1;
    if (!failed) {
        static const char owned[] = "FLOW_HOST_BRIDGE_V1 OWNED\n";
        if (write_bounded(STDOUT_FILENO, owned, sizeof(owned) - 1, startup) != 0) failed = 1;
    }
    if (!failed) {
        /* EOF after group ACK is only an exec-error-channel condition. Early
         * child termination is independently rejected by await_release(). */
        unsigned char error_record[6];
        const ssize_t count = read_bounded(report[0], error_record, sizeof(error_record), startup);
        if (count != 0) failed = 1;
    }
    if (close(report[0]) != 0) failed = 1;
    if (!failed && await_release(leader) != 0) failed = 1;
    if (settle_owned(leader, group) != 0) failed = 1;
    if (failed || interrupted) return 1;
    static const char settled[] = "FLOW_HOST_BRIDGE_V1 SETTLED\n";
    if (write_bounded(STDOUT_FILENO, settled, sizeof(settled) - 1, deadline_after(JOIN_MS)) != 0)
        return 1;
    return interrupted ? 1 : 0;
}
