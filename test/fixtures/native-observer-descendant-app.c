#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* Fixed qualification application, not candidate-controlled code. The host
 * discovers the held child's unique argv[0] through its own process inventory.
 * No PID from this application is used as host authority. */
extern char **environ;

static volatile sig_atomic_t cancellation_term_seen;

static void cancellation_term(int number) {
    (void)number;
    cancellation_term_seen = 1;
}

static int cancellation_signals(void) {
    struct sigaction action, actual;
    memset(&action, 0, sizeof(action));
    action.sa_handler = cancellation_term;
    sigset_t term, mask;
    if (sigemptyset(&action.sa_mask) != 0 ||
        sigaction(SIGTERM, &action, NULL) != 0 ||
        sigaction(SIGTERM, NULL, &actual) != 0 || actual.sa_handler != cancellation_term ||
        sigemptyset(&term) != 0 || sigaddset(&term, SIGTERM) != 0 ||
        sigprocmask(SIG_UNBLOCK, &term, NULL) != 0 ||
        sigprocmask(SIG_SETMASK, NULL, &mask) != 0 || sigismember(&mask, SIGTERM) != 0) return -1;
    return 0;
}

static int clean_entry(void) {
    DIR *directory = opendir("/proc/self/fd");
    if (directory == NULL) return -1;
    const int inventory = dirfd(directory);
    if (inventory < 0) return -1;
    unsigned int count = 0;
    int result = 0;
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(directory);
        if (entry == NULL) { if (errno != 0) result = -1; break; }
        if (++count > 4096) { result = -1; break; }
        if (entry->d_name[0] == '.') continue;
        char *end;
        errno = 0;
        const long fd = strtol(entry->d_name, &end, 10);
        if (errno != 0 || end == entry->d_name || *end != '\0' || fd < 0 ||
            fd > INT_MAX || (fd > 2 && fd != inventory)) { result = -1; break; }
    }
    if (closedir(directory) != 0) result = -1;
    return result;
}

static int marker_valid(const char *marker) {
    if (strlen(marker) != 64) return 0;
    for (unsigned int i = 0; i < 64; ++i)
        if (!((marker[i] >= '0' && marker[i] <= '9') ||
              (marker[i] >= 'a' && marker[i] <= 'f'))) return 0;
    return 1;
}

static int publish_notice(const char *path, const char *notice) {
    const int ready = open(path, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, 0600);
    if (ready < 0) return 113;
    const size_t length = strlen(notice);
    const ssize_t written = write(ready, notice, length);
    const int closed = close(ready);
    return written == (ssize_t)length && closed == 0 ? 0 : 114;
}

static int held(int argc, char **argv) {
    if (argc != 4 || !marker_valid(argv[0]) || argv[3][0] != '/' ||
        (strcmp(argv[2], "ordinary") != 0 && strcmp(argv[2], "new-session") != 0)) return 110;
    alarm(60); /* Host acceptance must occur well before this safety expiry. */
    const pid_t own = getpid();
    const pid_t session = getsid(0);
    /* An inherited session leader outside this PID namespace maps to zero.
     * Only -1 is a getsid failure. The host independently checks its own SID. */
    if (own <= 1 || getppid() <= 1 || session < 0 ||
        ((strcmp(argv[2], "new-session") == 0) != (session == own))) return 111;
    for (int fd = 0; fd <= 2; ++fd) {
        struct stat actual, expected;
        if (fstat(fd, &actual) != 0 || stat("/dev/null", &expected) != 0 ||
            !S_ISCHR(actual.st_mode) || actual.st_rdev != expected.st_rdev) return 112;
    }
    const int published = publish_notice(argv[3], session == 0 ? "ready-session-zero\n" : "ready\n");
    if (published != 0) return published;
    for (;;) pause();
}

/* Real application behavior only: this file never constructs observer records.
 * The cooperative parent exits normally only after a real TERM and host release;
 * the resistant parent acknowledges TERM but must be terminated externally. */
static int cancellation_parent(int mode, int release, const char *term_path) {
    static const char notice[] = "flow-observer-cancellation-parent:release-readonly\n";
    if (write(STDOUT_FILENO, notice, sizeof(notice) - 1) != (ssize_t)(sizeof(notice) - 1)) return 107;
    int notified = 0;
    for (;;) {
        unsigned char state;
        ssize_t length;
        do { length = pread(release, &state, 1, 0); } while (length < 0 && errno == EINTR);
        if (length != 1 || state > 1) return 108;
        if (state == 1) {
            if (mode == 1) {
                if (close(release) != 0) return 109;
                return cancellation_term_seen == 0 ? 0 : 122;
            }
            if (cancellation_term_seen != 0 && !notified) {
                const int result = publish_notice(term_path, "term-received\n");
                if (result != 0) return result;
                notified = 1;
            }
            if (mode == 2 && notified) return close(release) == 0 ? 0 : 109;
        }
        struct timespec delay = {.tv_sec = 0, .tv_nsec = 10000000};
        if (nanosleep(&delay, NULL) != 0 && errno != EINTR) return 109;
    }
}

int main(int argc, char **argv) {
    if (clean_entry() != 0) return 100;
    if (argc > 1 && strcmp(argv[1], "held") == 0) return held(argc, argv);
    if (argc != 5) return 101;
    const int cancel_mode = strcmp(argv[1], "cancel-control") == 0 ? 1
        : strcmp(argv[1], "cancel-cooperative") == 0 ? 2
        : strcmp(argv[1], "cancel-resistant") == 0 ? 3 : 0;
    if (argv[0][0] != '/' || !marker_valid(argv[2]) ||
        argv[3][0] != '/' || argv[4][0] != '/' ||
        (!cancel_mode && strcmp(argv[1], "ordinary") != 0 && strcmp(argv[1], "new-session") != 0)) return 101;
    alarm(15);
    char term_path[PATH_MAX];
    if (cancel_mode) {
        const size_t length = strnlen(argv[4], sizeof(term_path));
        if (length > sizeof(term_path) - sizeof(".term")) return 120;
        memcpy(term_path, argv[4], length);
        memcpy(term_path + length, ".term", sizeof(".term"));
    }
    const int release = open(argv[3], O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    if (release < 0) return 102;
    struct stat metadata;
    unsigned char state;
    if (fstat(release, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_size != 1 ||
        pread(release, &state, 1, 0) != 1 || state != 0) return 103;
    /* The host retains a write handle outside the sandbox. The exact existing
     * inode is admitted read-only; no rename or candidate-writable release file. */
    errno = 0;
    const int forbidden = open(argv[3], O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
    const int denied = errno;
    if (forbidden >= 0) { (void)close(forbidden); return 104; }
    if (denied != EROFS && denied != EACCES && denied != EPERM) return 105;
    if (cancel_mode && cancellation_signals() != 0) return 121;
    const pid_t child = fork();
    if (child < 0) return 106;
    if (child == 0) {
        if ((cancel_mode || strcmp(argv[1], "new-session") == 0) && setsid() < 0) _exit(115);
        const int null_fd = open("/dev/null", O_RDWR | O_CLOEXEC);
        if (null_fd < 0) _exit(116);
        for (int fd = 0; fd <= 2; ++fd)
            if (dup2(null_fd, fd) != fd) _exit(117);
        if (close(null_fd) != 0) _exit(118);
        char *arguments[] = {argv[2], "held", cancel_mode ? "new-session" : argv[1], argv[4], NULL};
        execve(argv[0], arguments, environ);
        _exit(119);
    }
    if (cancel_mode) return cancellation_parent(cancel_mode, release, term_path);
    static const char notice[] = "flow-observer-descendant-parent:release-readonly\n";
    if (write(STDOUT_FILENO, notice, sizeof(notice) - 1) != (ssize_t)(sizeof(notice) - 1)) return 107;
    for (;;) {
        if (pread(release, &state, 1, 0) != 1 || state > 1) return 108;
        if (state == 1) break;
        struct timespec delay = {.tv_sec = 0, .tv_nsec = 10000000};
        if (nanosleep(&delay, NULL) != 0 && errno != EINTR) return 109;
    }
    if (close(release) != 0) return 109;
    /* Deliberately do not reap or signal the held child: the real observer's
     * namespace settlement is the behavior under test. */
    return 7;
}
