FROM ghcr.io/tesserix/base-go-builder:latest AS builder
USER 0:0
WORKDIR /src

COPY apps/api/go.mod apps/api/go.sum ./
RUN go mod download

COPY apps/api/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -trimpath -ldflags="-s -w -buildid=" -o /out/server ./cmd/server

FROM ghcr.io/tesserix/base-distroless-static:latest
WORKDIR /app

COPY --from=builder --chown=65532:65532 /out/server /app/server

USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/app/server"]
