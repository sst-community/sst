package bridge

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"net/http"
)

// HttpRequestHead starts the body of a MessageHttpRequest, as a line of JSON,
// and the request's body follows it. The bridge of a web function sends one for
// each request it gets, with its own ID, so several can be in flight at once.
type HttpRequestHead struct {
	FunctionID string `json:"functionID"`
	Method     string `json:"method"`
	// the path and query, as the request had them
	URI    string      `json:"uri"`
	Host   string      `json:"host"`
	Header http.Header `json:"header"`
}

// HttpResponseHead starts the body of a MessageHttpResponse, as a line of JSON,
// and the response's body follows it. Its ID is the request's.
type HttpResponseHead struct {
	Status int         `json:"status"`
	Header http.Header `json:"header"`
}

// HttpTakenBody is the body of the MessagePing sst dev sends a web function's
// bridge while it has a request. A message's ID is its own, as a receiver drops a
// message with an ID it had, so the ping names the request in its body.
type HttpTakenBody struct {
	RequestID string `json:"requestID"`
}

// WriteHead writes head as a line of JSON, which never holds a newline of its
// own, so the body can follow it.
func WriteHead(w io.Writer, head any) error {
	data, err := json.Marshal(head)
	if err != nil {
		return err
	}
	_, err = w.Write(append(data, '\n'))
	return err
}

// maxHead is the longest head read. A web function's request head is at most
// 128 KiB, and its JSON a little more.
const maxHead = 1 << 20

var ErrHeadTooLong = errors.New("message head too long")

// ReadHead reads the line of JSON a message's body starts with into head, and
// returns a reader of the rest of the body.
func ReadHead(r io.Reader, head any) (io.Reader, error) {
	reader := bufio.NewReaderSize(r, 64*1024)
	var line []byte
	for {
		chunk, isPrefix, err := reader.ReadLine()
		if err != nil {
			return nil, err
		}
		line = append(line, chunk...)
		if len(line) > maxHead {
			return nil, ErrHeadTooLong
		}
		if !isPrefix {
			break
		}
	}
	if err := json.Unmarshal(line, head); err != nil {
		return nil, err
	}
	return reader, nil
}
