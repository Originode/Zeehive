-- Production modeled as a xell too — but flagged is_production and untouchable by zees.
ALTER TABLE xell ADD COLUMN is_production boolean NOT NULL DEFAULT false;

-- relax the branch check so a production xell may use a non-spinoff branch name
ALTER TABLE xell DROP CONSTRAINT xell_branch_is_spinoff;
ALTER TABLE xell ADD CONSTRAINT xell_branch_ok
  CHECK (is_production OR branch LIKE 'spinoff/%');
