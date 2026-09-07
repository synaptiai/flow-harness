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
    /* Diagnostic only: preserve the existing rejection until native execution
     * proves whether this child inherits an out-of-namespace session leader. */
    if (session == 0) {
        (void)publish_notice(argv[3], "session-zero\n");
        return 111;
    }
    if (own <= 1 || getppid() <= 1 || session <= 0 ||
        ((strcmp(argv[2], "new-session") == 0) != (session == own))) return 111;
    for (int fd = 0; fd <= 2; ++fd) {
        struct stat actual, expected;
        if (fstat(fd, &actual) != 0 || stat("/dev/null", &expected) != 0 ||
            !S_ISCHR(actual.st_mode) || actual.st_rdev != expected.st_rdev) return 112;
    }
    const int published = publish_notice(argv[3], "ready\n");
    if (published != 0) return published;
    for (;;) pause();
}

int main(int argc, char **argv) {
    if (clean_entry() != 0) return 100;
    if (argc > 1 && strcmp(argv[1], "held") == 0) return held(argc, argv);
    if (argc != 5 || argv[0][0] != '/' || !marker_valid(argv[2]) ||
        argv[3][0] != '/' || argv[4][0] != '/' ||
        (strcmp(argv[1], "ordinary") != 0 && strcmp(argv[1], "new-session") != 0)) return 101;
    alarm(15);
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
    const pid_t child = fork();
    if (child < 0) return 106;
    if (child == 0) {
        if (strcmp(argv[1], "new-session") == 0 && setsid() < 0) _exit(115);
        const int null_fd = open("/dev/null", O_RDWR | O_CLOEXEC);
        if (null_fd < 0) _exit(116);
        for (int fd = 0; fd <= 2; ++fd)
            if (dup2(null_fd, fd) != fd) _exit(117);
        if (close(null_fd) != 0) _exit(118);
        char *arguments[] = {argv[2], "held", argv[1], argv[4], NULL};
        execve(argv[0], arguments, environ);
        _exit(119);
    }
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
