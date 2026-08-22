package service

import "github.com/tesserix/tesserix-home/platform-api/internal/modules/tools/internal/repository"

// The wire shapes. snake_case, named payload objects, `[]` never null.
//
// Separate from repository.Tool so a column rename is not a contract change:
// the console's parser is written against THESE names, and they are in the
// golden files.

// ToolWire is one directory entry as a client sees it.
type ToolWire struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Subdomain string `json:"subdomain"`
	Purpose   string `json:"purpose"`
	// A pointer so absence is an explicit null rather than a missing key. A
	// client reading `note` should not have to distinguish the two.
	Note      *string `json:"note"`
	GroupKey  string  `json:"group_key"`
	SortOrder int     `json:"sort_order"`
}

// GroupWire is one heading as a client sees it.
type GroupWire struct {
	Key       string `json:"key"`
	Label     string `json:"label"`
	SortOrder int    `json:"sort_order"`
}

// ToolsPayload is the tools listing's `data`.
type ToolsPayload struct {
	Tools []ToolWire `json:"tools"`
}

// ToolPayload is one tool's `data`, which every write answers with.
type ToolPayload struct {
	Tool ToolWire `json:"tool"`
}

// GroupsPayload is the groups listing's `data`.
type GroupsPayload struct {
	Groups []GroupWire `json:"groups"`
}

// GroupPayload is one group's `data`.
type GroupPayload struct {
	Group GroupWire `json:"group"`
}

func toolWire(t repository.Tool) ToolWire {
	return ToolWire{
		ID: t.ID, Name: t.Name, Subdomain: t.Subdomain, Purpose: t.Purpose,
		Note: t.Note, GroupKey: t.GroupKey, SortOrder: t.SortOrder,
	}
}

func toolWires(rows []repository.Tool) []ToolWire {
	// Non-nil so an empty directory marshals as [] rather than null.
	out := make([]ToolWire, 0, len(rows))
	for _, row := range rows {
		out = append(out, toolWire(row))
	}
	return out
}

func groupWire(g repository.Group) GroupWire {
	return GroupWire{Key: g.Key, Label: g.Label, SortOrder: g.SortOrder}
}

func groupWires(rows []repository.Group) []GroupWire {
	out := make([]GroupWire, 0, len(rows))
	for _, row := range rows {
		out = append(out, groupWire(row))
	}
	return out
}
