#define _GNU_SOURCE

#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <unistd.h>

enum {
    FLOW_PRIME_HARDENING_FD = 4,
    FLOW_PRIME_HARDENING_PROOF = 1,
    FLOW_PRIME_HARDENING_FAILURE = 126,
};

static void fail_hardening(void) {
    _exit(FLOW_PRIME_HARDENING_FAILURE);
}

__attribute__((constructor)) static void harden_final_node_process(void) {
    const char *proof_fd = getenv("FLOW_PRIME_HARDENING_FD");
    if (proof_fd == NULL || strcmp(proof_fd, "4") != 0) {
        fail_hardening();
    }

    const struct rlimit core_limit = {.rlim_cur = 0, .rlim_max = 0};
    if (setrlimit(RLIMIT_CORE, &core_limit) != 0 ||
        prctl(PR_SET_DUMPABLE, 0, 0, 0, 0) != 0 ||
        prctl(PR_GET_DUMPABLE, 0, 0, 0, 0) != 0) {
        fail_hardening();
    }
    if (unsetenv("LD_PRELOAD") != 0 || unsetenv("FLOW_PRIME_HARDENING_FD") != 0) {
        fail_hardening();
    }

    const uint8_t proof = FLOW_PRIME_HARDENING_PROOF;
    ssize_t written;
    do {
        written = write(FLOW_PRIME_HARDENING_FD, &proof, sizeof(proof));
    } while (written < 0 && errno == EINTR);
    if (written != (ssize_t)sizeof(proof) || close(FLOW_PRIME_HARDENING_FD) != 0) {
        fail_hardening();
    }
}
