package workloadauth

import (
	"context"
	"errors"
	"fmt"

	authenticationv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	authenticationclient "k8s.io/client-go/kubernetes/typed/authentication/v1"
	"k8s.io/client-go/rest"
)

var ErrUnauthenticated = errors.New("workload token is not authenticated")

type Identity struct {
	Subject string
	UID     string
}

type Reviewer interface {
	Review(ctx context.Context, token, audience string) (Identity, error)
}

type KubernetesReviewer struct {
	client authenticationclient.AuthenticationV1Interface
}

func NewKubernetesReviewer(client authenticationclient.AuthenticationV1Interface) *KubernetesReviewer {
	return &KubernetesReviewer{client: client}
}

func NewInCluster() (*KubernetesReviewer, error) {
	cfg, err := rest.InClusterConfig()
	if err != nil {
		return nil, fmt.Errorf("workloadauth: in-cluster config: %w", err)
	}
	client, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("workloadauth: kubernetes client: %w", err)
	}
	return NewKubernetesReviewer(client.AuthenticationV1()), nil
}

func (r *KubernetesReviewer) Review(ctx context.Context, token, audience string) (Identity, error) {
	if token == "" || audience == "" {
		return Identity{}, ErrUnauthenticated
	}
	review, err := r.client.TokenReviews().Create(ctx, &authenticationv1.TokenReview{
		Spec: authenticationv1.TokenReviewSpec{
			Token:     token,
			Audiences: []string{audience},
		},
	}, metav1.CreateOptions{})
	if err != nil {
		return Identity{}, fmt.Errorf("workloadauth: review token: %w", err)
	}
	if !review.Status.Authenticated || !contains(review.Status.Audiences, audience) {
		return Identity{}, fmt.Errorf("%w: %s", ErrUnauthenticated, review.Status.Error)
	}
	if review.Status.User.Username == "" {
		return Identity{}, ErrUnauthenticated
	}
	return Identity{Subject: review.Status.User.Username, UID: review.Status.User.UID}, nil
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
