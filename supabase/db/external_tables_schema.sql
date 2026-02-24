--
-- PostgreSQL database dump
--

-- Dumped from database version 15.8
-- Dumped by pg_dump version 15.8

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: users; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.users (
    instance_id uuid,
    id uuid NOT NULL,
    aud character varying(255),
    role character varying(255),
    email character varying(255),
    encrypted_password character varying(255),
    email_confirmed_at timestamp with time zone,
    invited_at timestamp with time zone,
    confirmation_token character varying(255),
    confirmation_sent_at timestamp with time zone,
    recovery_token character varying(255),
    recovery_sent_at timestamp with time zone,
    email_change_token_new character varying(255),
    email_change character varying(255),
    email_change_sent_at timestamp with time zone,
    last_sign_in_at timestamp with time zone,
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    is_super_admin boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    phone text DEFAULT NULL::character varying,
    phone_confirmed_at timestamp with time zone,
    phone_change text DEFAULT ''::character varying,
    phone_change_token character varying(255) DEFAULT ''::character varying,
    phone_change_sent_at timestamp with time zone,
    confirmed_at timestamp with time zone GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
    email_change_token_current character varying(255) DEFAULT ''::character varying,
    email_change_confirm_status smallint DEFAULT 0,
    banned_until timestamp with time zone,
    reauthentication_token character varying(255) DEFAULT ''::character varying,
    reauthentication_sent_at timestamp with time zone,
    is_sso_user boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    is_anonymous boolean DEFAULT false NOT NULL,
    CONSTRAINT users_email_change_confirm_status_check CHECK (((email_change_confirm_status >= 0) AND (email_change_confirm_status <= 2)))
);


--
-- Name: TABLE users; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.users IS 'Auth: Stores user login data within a secure schema.';


--
-- Name: COLUMN users.is_sso_user; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.users.is_sso_user IS 'Auth: Set this column to true when the account comes from SSO. These accounts can have duplicate emails.';


--
-- Name: buckets; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.buckets (
    id text NOT NULL,
    name text NOT NULL,
    owner uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    public boolean DEFAULT false,
    avif_autodetection boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[],
    owner_id text,
    type storage.buckettype DEFAULT 'STANDARD'::storage.buckettype NOT NULL
);


--
-- Name: COLUMN buckets.owner; Type: COMMENT; Schema: storage; Owner: -
--

COMMENT ON COLUMN storage.buckets.owner IS 'Field is deprecated, use owner_id instead';


--
-- Name: objects; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket_id text,
    name text,
    owner uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_accessed_at timestamp with time zone DEFAULT now(),
    metadata jsonb,
    path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/'::text)) STORED,
    version text,
    owner_id text,
    user_metadata jsonb
);


--
-- Name: COLUMN objects.owner; Type: COMMENT; Schema: storage; Owner: -
--

COMMENT ON COLUMN storage.objects.owner IS 'Field is deprecated, use owner_id instead';


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: buckets buckets_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.buckets
    ADD CONSTRAINT buckets_pkey PRIMARY KEY (id);


--
-- Name: objects objects_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);


--
-- Name: confirmation_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX confirmation_token_idx ON auth.users USING btree (confirmation_token) WHERE ((confirmation_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: email_change_token_current_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX email_change_token_current_idx ON auth.users USING btree (email_change_token_current) WHERE ((email_change_token_current)::text !~ '^[0-9 ]*$'::text);


--
-- Name: email_change_token_new_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX email_change_token_new_idx ON auth.users USING btree (email_change_token_new) WHERE ((email_change_token_new)::text !~ '^[0-9 ]*$'::text);


--
-- Name: reauthentication_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX reauthentication_token_idx ON auth.users USING btree (reauthentication_token) WHERE ((reauthentication_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: recovery_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX recovery_token_idx ON auth.users USING btree (recovery_token) WHERE ((recovery_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: users_email_partial_key; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX users_email_partial_key ON auth.users USING btree (email) WHERE (is_sso_user = false);


--
-- Name: INDEX users_email_partial_key; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON INDEX auth.users_email_partial_key IS 'Auth: A partial unique index that applies only when is_sso_user is false';


--
-- Name: users_instance_id_email_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_instance_id_email_idx ON auth.users USING btree (instance_id, lower((email)::text));


--
-- Name: users_instance_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_instance_id_idx ON auth.users USING btree (instance_id);


--
-- Name: users_is_anonymous_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_is_anonymous_idx ON auth.users USING btree (is_anonymous);


--
-- Name: bname; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX bname ON storage.buckets USING btree (name);


--
-- Name: bucketid_objname; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX bucketid_objname ON storage.objects USING btree (bucket_id, name);


--
-- Name: idx_objects_bucket_id_name; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_objects_bucket_id_name ON storage.objects USING btree (bucket_id, name COLLATE "C");


--
-- Name: idx_objects_bucket_id_name_lower; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_objects_bucket_id_name_lower ON storage.objects USING btree (bucket_id, lower(name) COLLATE "C");


--
-- Name: name_prefix_search; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX name_prefix_search ON storage.objects USING btree (name text_pattern_ops);


--
-- Name: buckets enforce_bucket_name_length_trigger; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER enforce_bucket_name_length_trigger BEFORE INSERT OR UPDATE OF name ON storage.buckets FOR EACH ROW EXECUTE FUNCTION storage.enforce_bucket_name_length();


--
-- Name: buckets protect_buckets_delete; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();


--
-- Name: objects protect_objects_delete; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();


--
-- Name: objects update_objects_updated_at; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: objects objects_bucketId_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT "objects_bucketId_fkey" FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: users; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

--
-- Name: objects Allow authenticated users to delete their own folder; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Allow authenticated users to delete their own folder" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'avatars'::text) AND (name ~~ ((auth.uid())::text || '/%'::text))));


--
-- Name: objects Allow authenticated users to read their own folder; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Allow authenticated users to read their own folder" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'avatars'::text) AND (name ~~ ((auth.uid())::text || '/%'::text))));


--
-- Name: objects Allow authenticated users to update their own folder; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Allow authenticated users to update their own folder" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'avatars'::text) AND (name ~~ ((auth.uid())::text || '/%'::text))));


--
-- Name: objects Allow authenticated users to upload to their own folder; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Allow authenticated users to upload to their own folder" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'avatars'::text) AND (name ~~ ((auth.uid())::text || '/%'::text))));


--
-- Name: objects Allow read access for owner; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Allow read access for owner" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'documents'::text) AND ((auth.uid())::text = ( SELECT (mycompany.user_id)::text AS user_id
   FROM public.mycompany
  WHERE ((mycompany.company_id)::text = (string_to_array(mycompany.name, '/'::text))[1])))));


--
-- Name: objects Allow upload for owner; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Allow upload for owner" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'documents'::text) AND ((auth.uid())::text = ( SELECT (mycompany.user_id)::text AS user_id
   FROM public.mycompany
  WHERE ((mycompany.company_id)::text = (string_to_array(mycompany.name, '/'::text))[1])))));


--
-- Name: objects Authenticated users can insert into trips folder; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Authenticated users can insert into trips folder" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'photos'::text) AND ((storage.foldername(name))[1] = 'trips'::text)));


--
-- Name: objects Authenticated users can select from trips folder; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Authenticated users can select from trips folder" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'photos'::text) AND ((storage.foldername(name))[1] = 'trips'::text)));


--
-- Name: objects Authenticated users can update in trips folder; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Authenticated users can update in trips folder" ON storage.objects FOR UPDATE TO authenticated WITH CHECK (((bucket_id = 'photos'::text) AND ((storage.foldername(name))[1] = 'trips'::text)));


--
-- Name: objects Deny delete; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Deny delete" ON storage.objects FOR DELETE TO authenticated USING (false);


--
-- Name: objects Deny update; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Deny update" ON storage.objects FOR UPDATE TO authenticated USING (false);


--
-- Name: objects Enable insert for authenticated users only; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Enable insert for authenticated users only" ON storage.objects FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: objects Give anon users access to JPG images in folder 1io9m69_0; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Give anon users access to JPG images in folder 1io9m69_0" ON storage.objects FOR SELECT USING (((bucket_id = 'photos'::text) AND (storage.extension(name) = 'jpg'::text) AND (lower((storage.foldername(name))[1]) = 'public'::text) AND (auth.role() = 'anon'::text)));


--
-- Name: objects Give anon users access to JPG images in folder 1io9m69_1; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Give anon users access to JPG images in folder 1io9m69_1" ON storage.objects FOR UPDATE USING (((bucket_id = 'photos'::text) AND (storage.extension(name) = 'jpg'::text) AND (lower((storage.foldername(name))[1]) = 'public'::text) AND (auth.role() = 'anon'::text)));


--
-- Name: objects Give anon users access to JPG images in folder 1io9m69_2; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Give anon users access to JPG images in folder 1io9m69_2" ON storage.objects FOR DELETE USING (((bucket_id = 'photos'::text) AND (storage.extension(name) = 'jpg'::text) AND (lower((storage.foldername(name))[1]) = 'public'::text) AND (auth.role() = 'anon'::text)));


--
-- Name: objects Give anon users access to JPG images in folder 1io9m69_3; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Give anon users access to JPG images in folder 1io9m69_3" ON storage.objects FOR INSERT WITH CHECK (((bucket_id = 'photos'::text) AND (storage.extension(name) = 'jpg'::text) AND (lower((storage.foldername(name))[1]) = 'public'::text) AND (auth.role() = 'anon'::text)));


--
-- Name: objects Give anon users access to JPG images in folder 1oj01fe_0; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Give anon users access to JPG images in folder 1oj01fe_0" ON storage.objects FOR SELECT USING (((bucket_id = 'avatars'::text) AND (storage.extension(name) = 'jpg'::text) AND (lower((storage.foldername(name))[1]) = 'public'::text) AND (auth.role() = 'anon'::text)));


--
-- Name: objects Police aut 1x29udl_0; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Police aut 1x29udl_0" ON storage.objects FOR SELECT USING (((bucket_id = 'avatar-company'::text) AND (name ~~ ((auth.uid())::text || '/%'::text))));


--
-- Name: objects Police aut 1x29udl_1; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Police aut 1x29udl_1" ON storage.objects FOR INSERT WITH CHECK (((bucket_id = 'avatar-company'::text) AND (name ~~ ((auth.uid())::text || '/%'::text))));


--
-- Name: objects Police aut 1x29udl_2; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Police aut 1x29udl_2" ON storage.objects FOR UPDATE USING (((bucket_id = 'avatar-company'::text) AND (name ~~ ((auth.uid())::text || '/%'::text))));


--
-- Name: objects Police aut 1x29udl_3; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Police aut 1x29udl_3" ON storage.objects FOR DELETE USING (((bucket_id = 'avatar-company'::text) AND (name ~~ ((auth.uid())::text || '/%'::text))));


--
-- Name: objects anon police 1x29udl_0; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "anon police 1x29udl_0" ON storage.objects FOR SELECT USING (((bucket_id = 'avatar-company'::text) AND (storage.extension(name) = 'jpg'::text) AND (lower((storage.foldername(name))[1]) = 'public'::text) AND (auth.role() = 'anon'::text)));


--
-- Name: buckets; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;

--
-- Name: objects documents: owner can delete; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "documents: owner can delete" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'documents'::text) AND (owner = auth.uid())));


--
-- Name: objects documents: owner can read; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "documents: owner can read" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'documents'::text) AND (owner = auth.uid())));


--
-- Name: objects documents: owner can update; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "documents: owner can update" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'documents'::text) AND (owner = auth.uid()))) WITH CHECK (((bucket_id = 'documents'::text) AND (owner = auth.uid())));


--
-- Name: objects documents: owner can upload; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "documents: owner can upload" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'documents'::text) AND (owner = auth.uid())));


--
-- Name: objects evidences_delete_owner_or_admin; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY evidences_delete_owner_or_admin ON storage.objects FOR DELETE USING (((bucket_id = 'evidences'::text) AND ((owner = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.user_admin_access a
  WHERE ((a.user_id = auth.uid()) AND (a.is_admin OR (a.disputes = true))))))));


--
-- Name: objects evidences_insert_dispute_admin_or_participant; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY evidences_insert_dispute_admin_or_participant ON storage.objects FOR INSERT WITH CHECK (((bucket_id = 'evidences'::text) AND ((EXISTS ( SELECT 1
   FROM public.user_admin_access a
  WHERE ((a.user_id = auth.uid()) AND (a.is_admin OR (a.disputes = true))))) OR (EXISTS ( SELECT 1
   FROM ((public.disputes d
     JOIN public.chats c ON (((c.trip_id = d.trip_id) AND (c.chat_type = 'dispute'::text))))
     JOIN public.chat_participants cp ON (((cp.chat_id = c.id) AND (cp.user_id = auth.uid()))))
  WHERE (d.id = ("substring"(objects.name, '^evidences/([0-9a-f-]{36})/'::text))::uuid))))));


--
-- Name: objects evidences_select_dispute_participants; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY evidences_select_dispute_participants ON storage.objects FOR SELECT USING (((bucket_id = 'evidences'::text) AND (EXISTS ( SELECT 1
   FROM ((public.disputes d
     JOIN public.chats c ON (((c.trip_id = d.trip_id) AND (c.chat_type = 'dispute'::text))))
     JOIN public.chat_participants cp ON (((cp.chat_id = c.id) AND (cp.user_id = auth.uid()))))
  WHERE (d.id = ("substring"(objects.name, '^evidences/([0-9a-f-]{36})/'::text))::uuid)))));


--
-- Name: objects evidences_update_owner_or_admin; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY evidences_update_owner_or_admin ON storage.objects FOR UPDATE USING (((bucket_id = 'evidences'::text) AND ((owner = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.user_admin_access a
  WHERE ((a.user_id = auth.uid()) AND (a.is_admin OR (a.disputes = true)))))))) WITH CHECK (true);


--
-- Name: objects; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

--
-- Name: objects sobj_delete_trip_chat_files_owner_or_admin; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY sobj_delete_trip_chat_files_owner_or_admin ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'trip_chat_files'::text) AND (EXISTS ( SELECT 1
   FROM ((public.chat_message_files f
     JOIN public.chat_messages m ON ((m.id = f.message_id)))
     LEFT JOIN public.user_admin_access ua ON ((ua.user_id = auth.uid())))
  WHERE ((f.bucket = objects.bucket_id) AND (f.path = objects.name) AND ((m.user_id = auth.uid()) OR COALESCE(ua.is_admin, false) OR COALESCE(ua.chats, false)))))));


--
-- Name: objects sobj_read_trip_chat_files; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY sobj_read_trip_chat_files ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'trip_chat_files'::text) AND (EXISTS ( SELECT 1
   FROM ((((public.chat_message_files f
     JOIN public.chat_messages m ON ((m.id = f.message_id)))
     JOIN public.chats c ON ((c.id = m.chat_id)))
     LEFT JOIN public.chat_participants cp ON (((cp.chat_id = c.id) AND (cp.user_id = auth.uid()))))
     LEFT JOIN public.user_admin_access ua ON ((ua.user_id = auth.uid())))
  WHERE ((f.bucket = objects.bucket_id) AND (f.path = objects.name) AND ((cp.user_id IS NOT NULL) OR COALESCE(ua.is_admin, false) OR COALESCE(ua.chats, false)))))));


--
-- PostgreSQL database dump complete
--

