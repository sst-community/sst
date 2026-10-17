package process

import (
	"bufio"
	"io"
)

// ReadLines passes each line of r to onLine. A line longer than max bytes is not
// passed on: onTooLong is called once for it, and reading goes on with the next
// line, so the output after it is not lost.
func ReadLines(r io.Reader, max int, onLine func(string), onTooLong func()) error {
	reader := bufio.NewReader(r)
	var line []byte
	tooLong := false
	for {
		part, isPrefix, err := reader.ReadLine()
		if err != nil {
			if err == io.EOF {
				return nil
			}
			return err
		}
		if !tooLong {
			if len(line)+len(part) > max {
				tooLong = true
				line = nil
				onTooLong()
			} else {
				line = append(line, part...)
			}
		}
		if isPrefix {
			continue
		}
		if !tooLong {
			onLine(string(line))
		}
		line = line[:0]
		tooLong = false
	}
}
