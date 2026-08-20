package ingest

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"strings"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	collectorpb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
)

// The OTLP receiver.
//
// agentgateway exports spans here over OTLP/HTTP; this converts them and puts
// them on the stream. It does not touch Postgres: a receiver that wrote
// directly would put the database's latency inside the gateway's export path
// and lose the export outright whenever the database was down.
const (
	// The OTLP/HTTP spec's path. Fixed by the protocol, not chosen.
	TracesPath = "/v1/traces"

	protobufContentType = "application/x-protobuf"
	jsonContentType     = "application/json"

	// An export larger than this is a misconfiguration — the gateway batches
	// spans, it does not send a day of them at once — and an unbounded read is
	// how a single request exhausts the process.
	maxExportBytes = 8 << 20
)

// Sink is what the receiver hands records to. An interface here rather than
// `*Publisher` because the receiver's tests have no NATS server, and this is
// the seam that keeps them honest without one.
type Sink interface {
	Publish(ctx context.Context, record Record) error
}

// NewReceiver returns the OTLP endpoint plus liveness, ready to serve.
func NewReceiver(sink Sink, log *slog.Logger) *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+TracesPath, func(w http.ResponseWriter, r *http.Request) {
		serveTraces(w, r, sink, log)
	})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return mux
}

func serveTraces(w http.ResponseWriter, r *http.Request, sink Sink, log *slog.Logger) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxExportBytes))
	if err != nil {
		http.Error(w, "export too large", http.StatusRequestEntityTooLarge)
		return
	}

	var request collectorpb.ExportTraceServiceRequest
	asJSON := strings.Contains(r.Header.Get("Content-Type"), jsonContentType)
	if asJSON {
		err = protojson.Unmarshal(body, &request)
	} else {
		err = proto.Unmarshal(body, &request)
	}
	if err != nil {
		// 400, not 500: the exporter sent something this endpoint cannot read,
		// and OTLP tells it not to retry a request that will never decode.
		http.Error(w, "malformed OTLP export", http.StatusBadRequest)
		return
	}

	records := FromTraces(request.GetResourceSpans())
	for _, record := range records {
		if err := sink.Publish(r.Context(), record); err != nil {
			// 503 so the exporter retries the batch. A partially published
			// batch is safe to retry: the span id deduplicates it.
			log.Error("ai usage: publish failed", "span_id", record.SpanID, "error", err)
			http.Error(w, "the usage stream is unavailable", http.StatusServiceUnavailable)
			return
		}
	}

	response, err := marshalResponse(asJSON)
	if err != nil {
		log.Error("ai usage: encoding the OTLP response", "error", err)
		w.WriteHeader(http.StatusInternalServerError)
		return
	}
	if asJSON {
		w.Header().Set("Content-Type", jsonContentType)
	} else {
		w.Header().Set("Content-Type", protobufContentType)
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(response)
}

// OTLP requires a body of the response message's own type, not an empty 200.
func marshalResponse(asJSON bool) ([]byte, error) {
	response := &collectorpb.ExportTraceServiceResponse{}
	if asJSON {
		return protojson.Marshal(response)
	}
	return proto.Marshal(response)
}
