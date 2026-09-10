WITH duplicate_versions AS (
	SELECT "id", "project_id", "version", "created_at",
		row_number() OVER (
			PARTITION BY "project_id", "version"
			ORDER BY "created_at", "id"
		) AS duplicate_rank
	FROM "floor_models"
), excess_versions AS (
	SELECT "id", "project_id",
		row_number() OVER (
			PARTITION BY "project_id"
			ORDER BY "version", "created_at", "id"
		) AS append_rank
	FROM duplicate_versions
	WHERE duplicate_rank > 1
), project_max_versions AS (
	SELECT "project_id", max("version") AS max_version
	FROM "floor_models"
	GROUP BY "project_id"
)
UPDATE "floor_models" AS model
SET "version" = (project_max_versions.max_version + excess_versions.append_rank)::integer
FROM excess_versions
JOIN project_max_versions USING ("project_id")
WHERE model."id" = excess_versions."id";--> statement-breakpoint
WITH ranked_jobs AS (
	SELECT "id",
		row_number() OVER (
			PARTITION BY "project_id"
			ORDER BY "created_at" DESC, "id" DESC
		) AS job_rank
	FROM "tactile_designs"
	WHERE "status" = 'running'
)
UPDATE "tactile_designs" AS design
SET "status" = 'failed',
	"error" = coalesce(design."error", 'Superseded while adding single-flight job protection')
FROM ranked_jobs
WHERE design."id" = ranked_jobs."id" AND ranked_jobs.job_rank > 1;--> statement-breakpoint
CREATE UNIQUE INDEX "floor_models_project_version_unique" ON "floor_models" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "tactile_designs_one_running_per_project" ON "tactile_designs" USING btree ("project_id") WHERE "tactile_designs"."status" = 'running';
