#!/bin/sh
set -eu
umask 022
test "$(uname -m)" = x86_64
sha256sum --check inputs.sha256
mkdir /out /out/licenses /out/recipe /out/config
cp Dockerfile build.sh build.mjs source-check.mjs source-manifest.json inputs.sha256 musl-patched.sha256 /out/recipe/
cp -R sources /out/sources
tar -xjf sources/socat_1.8.1.3.orig.tar.bz2
tar -xzf sources/musl-1.2.6.tar.gz
cd musl-1.2.6
patch --batch --forward --fuzz=0 -p1 < ../sources/iconv.patch
patch --batch --forward --fuzz=0 -p1 < ../sources/qsort.patch
patch --batch --forward --fuzz=0 -p1 < ../sources/resolver.patch
sha256sum --check ../musl-patched.sha256
./configure --prefix=/opt/flow-musl --disable-shared --enable-wrapper=gcc \
  CFLAGS='-O2 -g0 -ffile-prefix-map=/source=.'
make -j2
make install
cp COPYRIGHT /out/licenses/musl-COPYRIGHT
cp config.mak /out/config/musl-config.mak
cp /opt/flow-musl/lib/libc.a /out/libc.a
cd ../socat-1.8.1.3
CC=/opt/flow-musl/bin/musl-gcc \
CFLAGS='-O2 -g0 -ffile-prefix-map=/source=.' \
LDFLAGS='-static -Wl,--build-id=none,-Map=/out/relay.link-map' \
./configure --disable-openssl --disable-libwrap --disable-exec --disable-system --disable-shell --disable-readline
make -j2 socat
cp socat /out/socat-static-baseline
cp config.h /out/config/socat-config.h
cp Makefile /out/config/socat-Makefile
cp COPYING /out/licenses/socat-COPYING
cp /usr/share/doc/gcc-12-base/copyright /out/licenses/gcc-copyright
cp /usr/share/common-licenses/GPL-3 /out/licenses/GPL-3
readelf --file-header /out/socat-static-baseline > /out/elf-header.txt
readelf --program-headers /out/socat-static-baseline > /out/elf-program-headers.txt
readelf --dynamic /out/socat-static-baseline > /out/elf-dynamic.txt
if grep -q INTERP /out/elf-program-headers.txt || grep -q NEEDED /out/elf-dynamic.txt; then
  exit 1
fi
# Only the explicit restricted-profile context captures this trusted recipe.
# Preserve the independently executable baseline and relink the same upstream objects.
if test -f /source/restricted-relay.c; then
  cp /source/restricted-relay.c /out/recipe/restricted-relay.c
  cp /source/restricted-relay.LICENSE /out/licenses/flow-relay-MIT
  cp /source/Flow-Apache-2.0.LICENSE /out/licenses/flow-Apache-2.0
  /opt/flow-musl/bin/musl-gcc -std=c11 -O2 -g0 -Wall -Wextra -Werror \
    -ffile-prefix-map=/source=. -c /source/restricted-relay.c -o /out/restricted-relay.o
  rm socat
  make socat LDFLAGS='-static -Wl,--build-id=none,--wrap=main,--wrap=getaddrinfo,-Map=/out/profile.link-map /out/restricted-relay.o'
  cp socat /out/flow-host-relay
  readelf --file-header /out/flow-host-relay > /out/profile-elf-header.txt
  readelf --program-headers /out/flow-host-relay > /out/profile-elf-program-headers.txt
  readelf --dynamic /out/flow-host-relay > /out/profile-elf-dynamic.txt
  if grep -q INTERP /out/profile-elf-program-headers.txt || grep -q NEEDED /out/profile-elf-dynamic.txt; then
    exit 1
  fi
  nm -n /out/flow-host-relay > /out/profile-symbols.txt
  {
    objdump -d --disassemble=_start_c /out/flow-host-relay
    objdump -d --disassemble=__wrap_main /out/flow-host-relay
    objdump -d --disassemble=Getaddrinfo /out/flow-host-relay
    objdump -d --disassemble=__wrap_getaddrinfo /out/flow-host-relay
  } > /out/profile-disassembly.txt
fi
{
  gcc --version
  ld --version
  make --version
  dpkg-query -W
} > /out/toolchain.txt
