module github.com/tesserix/tesserix-home/platform-api

go 1.26.5

require (
	github.com/jackc/pgx/v5 v5.10.0
	github.com/nats-io/nats.go v1.53.1
	go.opentelemetry.io/proto/otlp v1.11.0
	google.golang.org/protobuf v1.36.12
)

require github.com/coreos/go-oidc/v3 v3.20.0 // indirect

require (
	github.com/go-jose/go-jose/v4 v4.1.4 // indirect
	github.com/grpc-ecosystem/grpc-gateway/v2 v2.29.0 // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/klauspost/compress v1.18.5 // indirect
	github.com/nats-io/nkeys v0.4.15 // indirect
	github.com/nats-io/nuid v1.0.1 // indirect
	github.com/tesserix/tesserix-home/platform-auth v0.0.0
	golang.org/x/crypto v0.54.0 // indirect
	golang.org/x/net v0.57.0 // indirect
	golang.org/x/oauth2 v0.36.0 // indirect
	golang.org/x/sync v0.22.0 // indirect
	golang.org/x/sys v0.47.0 // indirect
	golang.org/x/text v0.40.0 // indirect
	google.golang.org/genproto/googleapis/api v0.0.0-20260720211330-0afa2a65878a // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260720211330-0afa2a65878a // indirect
	google.golang.org/grpc v1.82.1 // indirect
)

// platform-auth has no version tags, so the placeholder v0.0.0 require
// above needs a path telling Go where that version lives.
replace github.com/tesserix/tesserix-home/platform-auth => ../platform-auth
