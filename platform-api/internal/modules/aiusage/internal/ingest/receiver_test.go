package ingest_test

import (
	"bytes"
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	collectorpb "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	tracepb "go.opentelemetry.io/proto/otlp/trace/v1"

	"github.com/tesserix/tesserix-home/platform-api/internal/modules/aiusage/internal/ingest"
)

type recordingSink struct {
	mu      sync.Mutex
	records []ingest.Record
	err     error
}

func (s *recordingSink) Publish(_ context.Context, record ingest.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.records = append(s.records, record)
	return nil
}

func (s *recordingSink) stored() []ingest.Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.records
}

func discardLog() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func exportRequest(t *testing.T, spans []*tracepb.ResourceSpans) []byte {
	t.Helper()
	body, err := proto.Marshal(&collectorpb.ExportTraceServiceRequest{ResourceSpans: spans})
	if err != nil {
		t.Fatalf("marshalling the export: %v", err)
	}
	return body
}

func post(t *testing.T, sink ingest.Sink, contentType string, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, ingest.TracesPath, bytes.NewReader(body))
	request.Header.Set("Content-Type", contentType)
	response := httptest.NewRecorder()
	ingest.NewReceiver(sink, discardLog()).ServeHTTP(response, request)
	return response
}

func TestReceiverPublishesTheSpansItAccepts(t *testing.T) {
	t.Parallel()

	sink := &recordingSink{}
	response := post(t, sink, "application/x-protobuf",
		exportRequest(t, export("agentgateway", span(t, llm(nil)))))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", response.Code, response.Body.String())
	}
	if len(sink.stored()) != 1 {
		t.Fatalf("want 1 record published, got %d", len(sink.stored()))
	}
	if sink.stored()[0].RequestModel != "claude-opus-5" {
		t.Errorf("model = %q", sink.stored()[0].RequestModel)
	}

	// OTLP requires a body of the response message's own type, not a bare 200.
	var decoded collectorpb.ExportTraceServiceResponse
	if err := proto.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Errorf("the response is not an ExportTraceServiceResponse: %v", err)
	}
}

func TestReceiverAcceptsTheJSONEncoding(t *testing.T) {
	t.Parallel()

	body, err := protojson.Marshal(&collectorpb.ExportTraceServiceRequest{
		ResourceSpans: export("agentgateway", span(t, llm(nil))),
	})
	if err != nil {
		t.Fatalf("marshalling: %v", err)
	}

	sink := &recordingSink{}
	response := post(t, sink, "application/json", body)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body %q", response.Code, response.Body.String())
	}
	if len(sink.stored()) != 1 {
		t.Fatalf("want 1 record published, got %d", len(sink.stored()))
	}
	if got := response.Header().Get("Content-Type"); !strings.Contains(got, "application/json") {
		t.Errorf("content type = %q, want the encoding the exporter asked for", got)
	}
}

func TestReceiverAcceptsAnExportWithNothingToStore(t *testing.T) {
	t.Parallel()

	// The gateway exports health checks too. A 4xx here would make it retry an
	// export there is nothing wrong with.
	sink := &recordingSink{}
	response := post(t, sink, "application/x-protobuf", exportRequest(t, nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	if len(sink.stored()) != 0 {
		t.Errorf("want nothing published, got %d", len(sink.stored()))
	}
}

func TestReceiverRefusesAnUndecodableExportWithoutAskingForARetry(t *testing.T) {
	t.Parallel()

	sink := &recordingSink{}
	response := post(t, sink, "application/x-protobuf", []byte("not protobuf at all"))

	// 400, not 500: OTLP tells the exporter not to retry a request that will
	// never decode.
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
	if len(sink.stored()) != 0 {
		t.Errorf("want nothing published, got %d", len(sink.stored()))
	}
}

func TestReceiverAsksForARetryWhenTheStreamIsUnavailable(t *testing.T) {
	t.Parallel()

	sink := &recordingSink{err: errors.New("nats: no responders")}
	response := post(t, sink, "application/x-protobuf",
		exportRequest(t, export("agentgateway", span(t, llm(nil)))))

	// 503 so the batch comes back. Replaying it is safe: the span id
	// deduplicates whatever was already published.
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", response.Code)
	}
}

func TestReceiverServesLiveness(t *testing.T) {
	t.Parallel()

	response := httptest.NewRecorder()
	ingest.NewReceiver(&recordingSink{}, discardLog()).ServeHTTP(
		response, httptest.NewRequest(http.MethodGet, "/healthz", nil))

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
}

func TestReceiverRefusesAGETToTheTracesPath(t *testing.T) {
	t.Parallel()

	response := httptest.NewRecorder()
	ingest.NewReceiver(&recordingSink{}, discardLog()).ServeHTTP(
		response, httptest.NewRequest(http.MethodGet, ingest.TracesPath, nil))

	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", response.Code)
	}
}
