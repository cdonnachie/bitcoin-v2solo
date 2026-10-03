FROM rust:1.88-slim-bookworm AS build

WORKDIR /app
COPY tools/sv2-keygen/Cargo.toml ./Cargo.toml
COPY tools/sv2-keygen/src ./src
RUN cargo build --release

FROM debian:bookworm-slim

COPY --from=build /app/target/release/sv2-keygen /usr/local/bin/sv2-keygen
ENTRYPOINT ["sv2-keygen"]