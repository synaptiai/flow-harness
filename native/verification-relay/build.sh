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
{
  gcc --version
  ld --version
  make --version
  dpkg-query -W
} > /out/toolchain.txt
