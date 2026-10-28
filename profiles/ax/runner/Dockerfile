# Custom AX runner image. Build: docker buildx build --platform linux/amd64 --load -t apl-ax-runner:dev profiles/ax/runner
# Base images are pinned by index digest (resolved 2026-10-28). GKE c3 nodes are x86, hence linux/amd64.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine@sha256:d200d2dd76b03a99b52651fd1325aff7dcd35422c35c01bac56571b0507f3deb AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY main.go ./
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags="-s -w" -o /out/ax-task-runner .

# alpine:3.22 supplies /bin/sh for spec.command. git is not installed: a Workspace with spec.git leaves the task not-ready.
FROM alpine:3.22@sha256:2e0b81d60597f449baa56dc25d355367869d2dca4cd57e866f1e2b52af3eb55f
COPY --from=build /out/ax-task-runner /usr/local/bin/ax-task-runner
RUN mkdir -p /workspace
EXPOSE 80
ENTRYPOINT ["/usr/local/bin/ax-task-runner"]
