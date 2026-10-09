#!/bin/sh
# Test-only build of the patched observer helper from this checkout with the host toolchain.
# Runtime qualification tests use it on hosted Linux x64 runners. It is not the reproducible
# artifact from build.mjs, and Flow does not load it.
#
# Usage: build-test-helper.sh NEW_OUTPUT_DIRECTORY
# Prints the SHA-256 of OUTPUT/observer-apply-seccomp on success.
set -eu
umask 022
test "$(uname -m)" = x86_64
test "$#" -eq 1
output=$1
test ! -e "$output"
root=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
gcc -O2 -Wall -Wextra -o "$work/generator" "$root/upstream/seccomp-unix-block.c" -lseccomp
"$work/generator" "$work/unix-block.bpf" x86_64
{
  printf '#if !defined(__x86_64__) || defined(__ILP32__)\n#error "Linux x64 only"\n#endif\n'
  printf 'static const unsigned char unix_block_bpf[] = {\n'
  od -An -v -tx1 "$work/unix-block.bpf" | awk '{ for (i=1; i<=NF; i++) printf "0x%s,", $i; printf "\n"; }'
  printf '};\n'
} > "$work/unix-block-bpf.h"
cp "$root/upstream/apply-seccomp.c" "$work/observer-apply-seccomp.c"
patch --batch --forward --fuzz=0 --no-backup-if-mismatch --quiet \
  "$work/observer-apply-seccomp.c" "$root/observer/apply-seccomp.patch"
mkdir -p "$output"
gcc -static -O2 -Wall -Wextra -Werror -I "$root/observer" -I "$work" \
  -o "$output/observer-apply-seccomp" "$work/observer-apply-seccomp.c"
sha256sum "$output/observer-apply-seccomp" | cut -d ' ' -f 1
