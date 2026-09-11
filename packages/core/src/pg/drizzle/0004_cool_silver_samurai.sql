CREATE TABLE "facets" (
	"note_path" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"data" jsonb,
	"position" integer NOT NULL,
	CONSTRAINT "facets_pkey" PRIMARY KEY("note_path","key","position")
);
--> statement-breakpoint
ALTER TABLE "facets" ADD CONSTRAINT "facets_note_path_notes_path_fk" FOREIGN KEY ("note_path") REFERENCES "public"."notes"("path") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_facets_key_value" ON "facets" USING btree ("key","value");