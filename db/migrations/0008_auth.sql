-- 0008_auth.sql — users + sessions for authentication and RBAC.
-- Action-level permissions are mapped from the user's role in the backend.

CREATE TABLE app_user (
    id            BIGSERIAL PRIMARY KEY,
    branch_id     BIGINT REFERENCES branch(id),
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL,            -- 'owner' | 'manager' | 'cashier'
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE session (
    token       TEXT PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES app_user(id),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX idx_session_user ON session (user_id);
