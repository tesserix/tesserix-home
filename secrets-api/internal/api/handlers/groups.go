package handlers

import "github.com/gin-gonic/gin"

// Groups are the two authorisation tiers a handler registers routes into. A
// struct rather than two gin.IRoutes parameters, because those are the same
// type: Register(live, read) instead of Register(read, live) compiles, passes
// go vet, and passes the route-completeness test — both tiers answer 401
// without credentials identically — while silently widening every write
// route in the handler to the broader "platform" surface.
type Groups struct {
	// Read requires only the platform capability.
	Read gin.IRoutes
	// Live additionally requires rotate-credentials — routes that change live
	// state in OpenBao, Google Secret Manager, or tesserix-k8s belong here.
	Live gin.IRoutes
}
