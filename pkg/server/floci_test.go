package server

import (
	"fmt"
	"net"
	"testing"
	"time"
)

func TestFlociDevListenersAreHostOnly(t *testing.T) {
	for _, port := range []int{13557, 14557} {
		host, _, err := net.SplitHostPort(serverAddress(true, port))
		if err != nil || !net.ParseIP(host).IsLoopback() {
			t.Fatalf("Floci API/TLS address exposed: %s", host)
		}
	}
	listener, err := net.Listen("tcp", serverAddress(true, 0))
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	port := listener.Addr().(*net.TCPAddr).Port
	conn, err := net.DialTimeout("tcp", serverAddress(true, port), time.Second)
	if err != nil {
		t.Fatalf("local clients cannot connect: %v", err)
	}
	conn.Close()
	addresses, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	for _, address := range addresses {
		ip, _, err := net.ParseCIDR(address.String())
		if err != nil || ip.To4() == nil || ip.IsLoopback() {
			continue
		}
		conn, err := net.DialTimeout("tcp", net.JoinHostPort(ip.String(), fmt.Sprint(port)), 100*time.Millisecond)
		if err == nil {
			conn.Close()
			t.Fatalf("Floci dev API reachable through network interface %s", ip)
		}
	}
	if serverAddress(false, 13557) != "0.0.0.0:13557" {
		t.Fatal("cloud listener behavior changed")
	}
}

func TestFlociDiscoverySeparatesTargets(t *testing.T) {
	cfg := "/app/sst.config.ts"
	cloud := resolveServerFile(cfg, "local")
	first := resolveFlociServerFile(cfg, "local", "http://127.0.0.1:4566")
	second := resolveFlociServerFile(cfg, "local", "http://127.0.0.1:4567")
	if cloud == first || cloud == second || first == second {
		t.Fatal("dev server discovery paths collide")
	}
	if first != resolveFlociServerFile(cfg, "local", "http://127.0.0.1:4566") {
		t.Fatal("discovery path unstable")
	}
}
