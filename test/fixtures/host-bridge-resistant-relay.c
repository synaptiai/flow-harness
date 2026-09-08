/* Fixed test-only relay-shaped lifecycle fixture. It does NOT forward traffic.
 * Compile a separate cooperative twin with -DFLOW_TEST_COOPERATIVE=1.
 * The child connects after fork so SO_PEERPIDFD identifies the child, not leader.
 * The resistant child has no normal exit path after its verified TERM receipt.
 */
#define _GNU_SOURCE
#if !defined(__linux__) || !defined(__x86_64__) || defined(__ILP32__)
#error "Resistance fixture requires Linux x64"
#endif
#include <signal.h>
#include <stddef.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

int main(int argc, char **argv) {
    const char prefix[] = "UNIX-LISTEN:", suffix[] = ",fork,reuseaddr";
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    if (argc != 3 || strncmp(argv[1], prefix, sizeof(prefix) - 1) != 0) return 110;
    const size_t length = strlen(argv[1]);
    if (length <= sizeof(prefix) - 1 + sizeof(suffix) - 1 ||
        strcmp(argv[1] + length - (sizeof(suffix) - 1), suffix) != 0) return 110;
    const size_t path_length = length - (sizeof(prefix) - 1) - (sizeof(suffix) - 1);
    if (path_length >= sizeof(address.sun_path)) return 110;
    memcpy(address.sun_path, argv[1] + sizeof(prefix) - 1, path_length);
    address.sun_family = AF_UNIX;
#ifndef FLOW_TEST_COOPERATIVE
    const pid_t guardian = getppid();
    sigset_t term;
    if (sigemptyset(&term) != 0 || sigaddset(&term, SIGTERM) != 0) return 111;
#endif
    const pid_t child = fork();
    if (child < 0) return 112;
    if (child > 0) for (;;) pause(); /* Leader retains default TERM disposition. */
#ifndef FLOW_TEST_COOPERATIVE
    if (sigprocmask(SIG_BLOCK, &term, NULL) != 0) return 113;
#endif
    const int connection = socket(AF_UNIX, SOCK_SEQPACKET | SOCK_CLOEXEC, 0);
    if (connection < 0 || connect(connection, (struct sockaddr *)&address, sizeof(address)) != 0 ||
        send(connection, "R", 1, MSG_NOSIGNAL) != 1) return 114;
#ifndef FLOW_TEST_COOPERATIVE
    siginfo_t information;
    memset(&information, 0, sizeof(information));
    if (sigwaitinfo(&term, &information) != SIGTERM || information.si_code != SI_USER ||
        information.si_pid != guardian || information.si_uid != getuid()) return 115;
    if (send(connection, "T", 1, MSG_NOSIGNAL) != 1) return 116;
#endif
    for (;;) pause(); /* No normal exit after receipt; guardian KILL must dispose it. */
}
