#!/bin/sh
set -eu
umask 022
test "$(uname -m)" = x86_64
mkdir -p /build /out/licenses /out/sources/glibc
cd /build
gcc -static -O2 -Wall -Wextra -ffile-prefix-map=/source=. -ffile-prefix-map=/build=. \
  -frandom-seed=flow-upstream-seccomp-generator -Wl,--build-id=none \
  -o generator /source/upstream/seccomp-unix-block.c -lseccomp
./generator /out/unix-block.bpf x86_64
{
  printf '#if !defined(__x86_64__) || defined(__ILP32__)\n#error "Linux x64 only"\n#endif\n'
  printf 'static const unsigned char unix_block_bpf[] = {\n'
  od -An -v -tx1 /out/unix-block.bpf | awk '{ for (i=1; i<=NF; i++) printf "0x%s,", $i; printf "\n"; }'
  printf '};\n'
} > /out/unix-block-bpf.h
gcc -O2 -Wall -Wextra -ffile-prefix-map=/source=. -ffile-prefix-map=/build=. \
  -fdebug-prefix-map=/out=. -frandom-seed=flow-upstream-apply-seccomp \
  -I /out -c /source/upstream/apply-seccomp.c -o /out/upstream-apply-seccomp.o
gcc -static -Wl,--build-id=none -o /out/upstream-apply-seccomp /out/upstream-apply-seccomp.o
strip --strip-all /out/upstream-apply-seccomp
readelf --file-header /out/upstream-apply-seccomp | grep -q 'Advanced Micro Devices X86-64'
if readelf --program-headers /out/upstream-apply-seccomp | grep -q INTERP; then exit 1; fi
if readelf --dynamic /out/upstream-apply-seccomp | grep -q NEEDED; then exit 1; fi
dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' | LC_ALL=C sort > /out/toolchain.txt
gcc --version >> /out/toolchain.txt
ld --version >> /out/toolchain.txt
sha256sum /usr/bin/gcc /usr/bin/ld /usr/bin/strip >> /out/toolchain.txt
cp /source/upstream/LICENSE /out/licenses/SRT-LICENSE
cp /usr/share/doc/libc6/copyright /out/licenses/libc-copyright
cp /usr/share/doc/gcc-12-base/copyright /out/licenses/libgcc-copyright
cp /usr/share/doc/libseccomp2/copyright /out/licenses/libseccomp-copyright
cp /usr/share/common-licenses/LGPL-2.1 /out/licenses/LGPL-2.1
cp /usr/share/common-licenses/GPL-2 /out/licenses/GPL-2
cp /usr/share/common-licenses/GPL-3 /out/licenses/GPL-3
# Preserve the exact libc source package and the application object for relinking.
libc_source_version=$(dpkg-query -W -f='${source:Version}' libc6-dev)
cd /out/sources/glibc
apt-get source --download-only "glibc=$libc_source_version"
rm -f /out/sources/glibc/lock
find /out -type f -exec touch --date="@$SOURCE_DATE_EPOCH" {} +
