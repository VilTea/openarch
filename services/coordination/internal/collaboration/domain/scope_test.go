package domain

import "testing"

func mustRepository(t *testing.T, id string) RepositoryRef {
	t.Helper()
	repository, err := NewRepositoryRef(id)
	if err != nil {
		t.Fatal(err)
	}
	return repository
}

func mustService(t *testing.T, repository RepositoryRef, id string) ServiceRef {
	t.Helper()
	service, err := NewServiceRef(repository, id)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestScopeSupportsSameNamedRepositoriesAndMonorepoServices(t *testing.T) {
	firstRepository := mustRepository(t, "repo-alpha")
	secondRepository := mustRepository(t, "repo-beta")
	firstService := mustService(t, firstRepository, "api")
	secondService := mustService(t, secondRepository, "api")
	monorepoWorker := mustService(t, firstRepository, "worker")

	product, err := NewProductRef("product-main", []ServiceRef{firstService, secondService, monorepoWorker})
	if err != nil {
		t.Fatal(err)
	}
	if err := product.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestServiceCanExistWithoutProductAssociation(t *testing.T) {
	service := mustService(t, mustRepository(t, "repo-solo"), "cli")
	if err := service.Validate(); err != nil {
		t.Fatal(err)
	}
}

func TestProductRejectsEmptyAndDuplicateServices(t *testing.T) {
	repository := mustRepository(t, "repo-main")
	service := mustService(t, repository, "api")
	if _, err := NewProductRef("product-empty", nil); err == nil {
		t.Fatal("empty product was accepted")
	}
	if _, err := NewProductRef("product-duplicate", []ServiceRef{service, service}); err == nil {
		t.Fatal("duplicate service reference was accepted")
	}
}

func TestScopeRejectsPathLikeAndUnboundIdentifiers(t *testing.T) {
	if _, err := NewRepositoryRef(`E:\workspace\repo`); err == nil {
		t.Fatal("path-like repository identity was accepted")
	}
	if _, err := NewServiceRef(RepositoryRef{}, "api"); err == nil {
		t.Fatal("service without a repository was accepted")
	}
}

func TestLegacyProjectMigrationRequiresExplicitRepositoryID(t *testing.T) {
	migrated, err := MigrateLegacyProject(LegacyProjectRef{Path: `projects\same-name`}, "repo-explicit")
	if err != nil {
		t.Fatal(err)
	}
	if migrated.ID != "repo-explicit" {
		t.Fatalf("migration used the wrong identity: %q", migrated.ID)
	}
	if _, err := MigrateLegacyProject(LegacyProjectRef{Path: "projects/same-name"}, ""); err == nil {
		t.Fatal("migration accepted an omitted repository identity")
	}
	if _, err := MigrateLegacyProject(LegacyProjectRef{Path: "not-projects/same-name"}, "repo-explicit"); err == nil {
		t.Fatal("migration accepted an unrelated path")
	}
}

func TestRepositorySyncNoticeRequiresExplicitSafeIdentityAndHead(t *testing.T) {
	notice := RepositorySyncNotice{
		RepositoryID: mustRepository(t, "repo-main").ID,
		Branch:       "main",
		HeadSHA:      "0123456789abcdef0123456789abcdef01234567",
	}
	if err := notice.Validate(); err != nil {
		t.Fatalf("valid sync notice rejected: %v", err)
	}
	for _, invalid := range []RepositorySyncNotice{
		{RepositoryID: notice.RepositoryID, Branch: "-c", HeadSHA: notice.HeadSHA},
		{RepositoryID: notice.RepositoryID, Branch: "main", HeadSHA: "short"},
		{RepositoryID: notice.RepositoryID, Branch: "main", HeadSHA: "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"},
	} {
		if err := invalid.Validate(); err == nil {
			t.Fatalf("invalid sync notice accepted: %+v", invalid)
		}
	}
}
