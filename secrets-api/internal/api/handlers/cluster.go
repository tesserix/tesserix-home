package handlers

import (
	"net/http"

	"github.com/gin-gonic/gin"

	"github.com/tesserix/tesserix-home/secrets-api/internal/k8s"
)

// Cluster exposes the read-only view of the cluster the console needs to offer
// real namespaces and service accounts rather than free-text fields.
type Cluster struct {
	discovery *k8s.Discoverer
}

func NewCluster(d *k8s.Discoverer) *Cluster {
	return &Cluster{discovery: d}
}

func (h *Cluster) Register(r gin.IRoutes) {
	r.GET("/api/cluster/namespaces", h.Namespaces)
	r.GET("/api/cluster/namespaces/:namespace/apps", h.Apps)
}

func (h *Cluster) Namespaces(c *gin.Context) {
	if h.discovery == nil {
		c.JSON(http.StatusOK, gin.H{"namespaces": []k8s.Namespace{}})
		return
	}

	namespaces, err := h.discovery.Namespaces(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "cluster unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"namespaces": namespaces})
}

func (h *Cluster) Apps(c *gin.Context) {
	if h.discovery == nil {
		c.JSON(http.StatusOK, gin.H{"apps": []k8s.App{}})
		return
	}

	apps, err := h.discovery.Apps(c.Request.Context(), c.Param("namespace"))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"apps": apps})
}
