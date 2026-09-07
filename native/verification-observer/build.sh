#!/bin/sh
set -eu
umask 022
test "$(uname -m)" = x86_64
mode=${1:-baseline}
case "$mode" in baseline|observer) ;; *) exit 1 ;; esac
controls=${2:-none}
case "$mode:$controls" in baseline:none|observer:none|observer:false-normal-v1) ;; *) exit 1 ;; esac
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
if [ "$mode" = observer ]; then
  mkdir /build/observer /out/observer
  cp /source/upstream/apply-seccomp.c /build/observer/apply-seccomp.c
  cp /source/observer/observer.patch /source/observer/observer-application.h /source/observer/observer-result.h /source/observer/host-bridge-guardian.c /build/observer/
  cd /build/observer
  patch --batch --forward --fuzz=0 -p1 < observer.patch
  gcc -O2 -Wall -Wextra -Werror -ffile-prefix-map=/source=. -ffile-prefix-map=/build=. \
    -fdebug-prefix-map=/out=. -frandom-seed=flow-observer-apply-seccomp \
    -I /out -c apply-seccomp.c -o /out/flow-observer-apply-seccomp.o
  gcc -static -Wl,--build-id=none -o /out/flow-observer-apply-seccomp /out/flow-observer-apply-seccomp.o
  strip --strip-all /out/flow-observer-apply-seccomp
  readelf --file-header /out/flow-observer-apply-seccomp | grep -q 'Advanced Micro Devices X86-64'
  if readelf --program-headers /out/flow-observer-apply-seccomp | grep -q INTERP; then exit 1; fi
  if readelf --dynamic /out/flow-observer-apply-seccomp | grep -q NEEDED; then exit 1; fi
  gcc -O2 -Wall -Wextra -Werror -ffile-prefix-map=/source=. -ffile-prefix-map=/build=. \
    -fdebug-prefix-map=/out=. -frandom-seed=flow-host-bridge-guardian \
    -c host-bridge-guardian.c -o /out/flow-host-bridge-guardian.o
  gcc -static -Wl,--build-id=none -o /out/flow-host-bridge-guardian /out/flow-host-bridge-guardian.o
  strip --strip-all /out/flow-host-bridge-guardian
  readelf --file-header /out/flow-host-bridge-guardian | grep -q 'Advanced Micro Devices X86-64'
  if readelf --program-headers /out/flow-host-bridge-guardian | grep -q INTERP; then exit 1; fi
  if readelf --dynamic /out/flow-host-bridge-guardian | grep -q NEEDED; then exit 1; fi
  cp apply-seccomp.c observer.patch observer-application.h observer-result.h host-bridge-guardian.c /out/observer/
  cp /source/upstream/apply-seccomp.c /out/observer/upstream-apply-seccomp.c
  cp /source/source-manifest.json /out/observer/source-manifest.json
  if [ "$controls" = false-normal-v1 ]; then
    # Never mutate /source, the genuine TU directory, or genuine output. Quoted
    # header lookup resolves within this physically separate test-only copy.
    mkdir -p /build/test-controls/false-normal /out/test-controls/false-normal
    cp /build/observer/apply-seccomp.c /build/observer/observer-result.h /build/test-controls/false-normal/
    cp /source/test-controls/false-normal/observer-application.h /source/test-controls/false-normal/mutation.json /build/test-controls/false-normal/
    cd /build/test-controls/false-normal
    gcc -O2 -Wall -Wextra -Werror -ffile-prefix-map=/source=. -ffile-prefix-map=/build=. \
      -fdebug-prefix-map=/out=. -frandom-seed=flow-observer-apply-seccomp \
      -I /out -c apply-seccomp.c -o /out/test-controls/false-normal/flow-observer-apply-seccomp-false-normal.o
    gcc -static -Wl,--build-id=none -o /out/test-controls/false-normal/flow-observer-apply-seccomp-false-normal /out/test-controls/false-normal/flow-observer-apply-seccomp-false-normal.o
    strip --strip-all /out/test-controls/false-normal/flow-observer-apply-seccomp-false-normal
    readelf --file-header /out/test-controls/false-normal/flow-observer-apply-seccomp-false-normal | grep -q 'Advanced Micro Devices X86-64'
    if readelf --program-headers /out/test-controls/false-normal/flow-observer-apply-seccomp-false-normal | grep -q INTERP; then exit 1; fi
    if readelf --dynamic /out/test-controls/false-normal/flow-observer-apply-seccomp-false-normal | grep -q NEEDED; then exit 1; fi
    cp apply-seccomp.c observer-application.h observer-result.h mutation.json /out/test-controls/false-normal/
  fi
fi
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
