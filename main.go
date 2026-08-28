package main

import (
	"log"

	"tg_verification_go/src/cmd"
)

func main() {
	if err := cmd.Run(); err != nil {
		log.Fatalf("[main][start] server exited: %v", err)
	}
}
