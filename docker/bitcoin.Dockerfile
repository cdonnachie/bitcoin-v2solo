FROM debian:bookworm-slim

ARG BITCOIN_VERSION=30.2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

RUN set -eu; \
    archive="bitcoin-${BITCOIN_VERSION}-x86_64-linux-gnu.tar.gz"; \
    url="https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}"; \
    curl --fail --location --retry 3 "$url/$archive" -o "/tmp/$archive"; \
    curl --fail --location --retry 3 "$url/SHA256SUMS" -o /tmp/SHA256SUMS; \
    cd /tmp; \
    grep " $archive\$" SHA256SUMS | sha256sum --check --strict -; \
    mkdir -p /opt/bitcoin; \
    tar -xzf "$archive" -C /opt/bitcoin --strip-components=1; \
    rm "$archive" SHA256SUMS; \
    groupadd --gid 1000 bitcoin; \
    useradd --uid 1000 --gid bitcoin --create-home bitcoin; \
    mkdir -p /data; \
    chown bitcoin:bitcoin /data

ENV PATH="/opt/bitcoin/bin:${PATH}"
USER bitcoin
VOLUME ["/data"]
ENTRYPOINT ["bitcoin", "-m", "node"]
CMD ["-datadir=/data", "-server=1", "-ipcbind=unix", "-disablewallet=1", "-printtoconsole=1"]