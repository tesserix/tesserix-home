package workloadauth_test

import (
	"context"
	"errors"
	"testing"

	authenticationv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"

	"github.com/tesserix/tesserix-home/secrets-api/internal/workloadauth"
)

func TestKubernetesReviewerReturnsAuthenticatedWorkload(t *testing.T) {
	client := fake.NewClientset()
	client.PrependReactor("create", "tokenreviews", func(action ktesting.Action) (bool, runtime.Object, error) {
		create := action.(ktesting.CreateAction)
		review := create.GetObject().(*authenticationv1.TokenReview)
		if review.Spec.Token != "projected-token" {
			t.Fatalf("token = %q", review.Spec.Token)
		}
		if len(review.Spec.Audiences) != 1 || review.Spec.Audiences[0] != "secret-service" {
			t.Fatalf("audiences = %v", review.Spec.Audiences)
		}
		return true, &authenticationv1.TokenReview{
			ObjectMeta: metav1.ObjectMeta{Name: "review"},
			Status: authenticationv1.TokenReviewStatus{
				Authenticated: true,
				Audiences:     []string{"secret-service"},
				User: authenticationv1.UserInfo{
					Username: "system:serviceaccount:devai:devai-api",
					UID:      "pod-bound-token",
				},
			},
		}, nil
	})

	reviewer := workloadauth.NewKubernetesReviewer(client.AuthenticationV1())
	identity, err := reviewer.Review(context.Background(), "projected-token", "secret-service")
	if err != nil {
		t.Fatalf("Review: %v", err)
	}
	if identity.Subject != "system:serviceaccount:devai:devai-api" {
		t.Fatalf("Subject = %q", identity.Subject)
	}
}

func TestKubernetesReviewerRejectsUnauthenticatedToken(t *testing.T) {
	client := fake.NewClientset()
	client.PrependReactor("create", "tokenreviews", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, &authenticationv1.TokenReview{
			Status: authenticationv1.TokenReviewStatus{Authenticated: false, Error: "invalid token"},
		}, nil
	})

	reviewer := workloadauth.NewKubernetesReviewer(client.AuthenticationV1())
	_, err := reviewer.Review(context.Background(), "bad", "secret-service")
	if !errors.Is(err, workloadauth.ErrUnauthenticated) {
		t.Fatalf("Review error = %v, want ErrUnauthenticated", err)
	}
}

func TestKubernetesReviewerRejectsWrongAudience(t *testing.T) {
	client := fake.NewClientset()
	client.PrependReactor("create", "tokenreviews", func(ktesting.Action) (bool, runtime.Object, error) {
		return true, &authenticationv1.TokenReview{
			Status: authenticationv1.TokenReviewStatus{
				Authenticated: true,
				Audiences:     []string{"kubernetes.default.svc"},
				User:          authenticationv1.UserInfo{Username: "system:serviceaccount:devai:devai-api"},
			},
		}, nil
	})

	reviewer := workloadauth.NewKubernetesReviewer(client.AuthenticationV1())
	_, err := reviewer.Review(context.Background(), "wrong-audience", "secret-service")
	if !errors.Is(err, workloadauth.ErrUnauthenticated) {
		t.Fatalf("Review error = %v, want ErrUnauthenticated", err)
	}
}
