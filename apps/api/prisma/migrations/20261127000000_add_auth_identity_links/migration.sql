-- Muneral sign-in through Auth Arcana (M2): the link between an Auth Arcana user and a local user.
-- Additive only: one new table. No existing table, column or row is changed, so the previously
-- deployed API keeps working while this migration is applied ahead of the new image.
-- One link per Auth user (primary key) and one per local user (unique).

CREATE TABLE public.auth_identity_links (
    auth_user_id UUID NOT NULL,
    user_id UUID NOT NULL,
    link_method VARCHAR NOT NULL,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT auth_identity_links_pkey PRIMARY KEY (auth_user_id),
    CONSTRAINT auth_identity_links_user_id_key UNIQUE (user_id),
    CONSTRAINT auth_identity_links_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES public.users(id)
      ON DELETE CASCADE ON UPDATE CASCADE
);
