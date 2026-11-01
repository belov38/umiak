# Keep the upstream runtime and a small, reviewable authentication policy patch.
FROM coturn/coturn:4.18.0-r0 AS build
USER root
RUN apt-get update
RUN apt-get install -y --no-install-recommends build-essential libssl-dev libevent-dev libsqlite3-dev pkg-config curl patch
WORKDIR /src
ADD --checksum=sha256:d7e2ee337b5298c30cc5cd365c3173d05b97c749d28e9416afa4ca907925ce15 https://github.com/coturn/coturn/archive/23c6c1d32a3d2b21a56cee65d3203bcc4ea82d2b.tar.gz /source.tar.gz
RUN tar -xzf /source.tar.gz --strip-components=1 -C /src
COPY refresh-auth.patch /refresh-auth.patch
RUN patch -p1 < /refresh-auth.patch
RUN ./configure --prefix=/usr --sysconfdir=/etc/coturn --disable-rpath
RUN make -j2

FROM coturn/coturn:4.18.0-r0
USER root
COPY --from=build /src/bin/turnserver /usr/bin/turnserver
COPY --from=build /src/LICENSE /usr/share/licenses/coturn/LICENSE
COPY refresh-auth.patch /usr/share/licenses/coturn/refresh-auth.patch
RUN apt-get update
RUN apt-get install -y --no-install-recommends libcap2-bin nftables
LABEL org.opencontainers.image.source="https://github.com/coturn/coturn" \
      org.opencontainers.image.revision="23c6c1d32a3d2b21a56cee65d3203bcc4ea82d2b+s10-refresh-auth"
# entrypoint.sh installs the relay egress table as root, then drops to SBX_TURN_UID.
USER 0:0
