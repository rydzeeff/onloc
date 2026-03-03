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

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: chat_message_reads_fill_chat_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.chat_message_reads_fill_chat_id() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if new.chat_id is null then
    select chat_id into new.chat_id
    from public.chat_messages
    where id = new.message_id;
  end if;
  return new;
end;
$$;


--
-- Name: compute_open_count_after_refund(uuid, uuid, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compute_open_count_after_refund(p_trip_id uuid, p_payment_db_id uuid, p_refund_amount_rub numeric) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
declare
  v_eps numeric := 0.005;
  v_count int := 0;
begin
  if coalesce(p_refund_amount_rub,0) < 0 then
    return null;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_trip_id::text));

  with confirmed as (
    select p.id, p.amount::numeric as gross_paid
    from public.payments p
    where p.trip_id = p_trip_id
      and p.payment_type = 'participant_payment'
      and p.status = 'confirmed'
  ),
  refunds as (
    select payment_id, coalesce(sum(amount),0)::numeric as refunded
    from public.payment_refunds
    where status = 'confirmed'
    group by payment_id
  ),
  paidouts as (
    select source_payment_id, coalesce(sum(amount_gross_equiv_rub),0)::numeric as paid_out_gross
    from public.payout_attempts
    where status in ('pending','completed')
    group by source_payment_id
  ),
  left_after as (
    select c.id,
           c.gross_paid
         - coalesce(r.refunded,0)
         - coalesce(po.paid_out_gross,0)
         - case when c.id = p_payment_db_id then p_refund_amount_rub else 0 end
           as gross_left
    from confirmed c
    left join refunds r on r.payment_id = c.id
    left join paidouts po on po.source_payment_id = c.id
  )
  select count(*) into v_count
  from left_after
  where gross_left > v_eps;

  return v_count;
end
$$;


--
-- Name: compute_open_count_now(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.compute_open_count_now(p_trip_id uuid) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
declare
  v_eps numeric := 0.005;
  v_count int := 0;
begin
  perform pg_advisory_xact_lock(hashtext(p_trip_id::text));

  with confirmed as (
    select p.id, p.amount::numeric as gross_paid
    from public.payments p
    where p.trip_id = p_trip_id
      and p.payment_type = 'participant_payment'
      and p.status = 'confirmed'
  ),
  refunds as (
    select payment_id, coalesce(sum(amount),0)::numeric as refunded
    from public.payment_refunds
    where status = 'confirmed'
    group by payment_id
  ),
  paidouts as (
    select source_payment_id, coalesce(sum(amount_gross_equiv_rub),0)::numeric as paid_out_gross
    from public.payout_attempts
    where status in ('pending','completed')
    group by source_payment_id
  ),
  left_now as (
    select c.id,
           c.gross_paid
         - coalesce(r.refunded,0)
         - coalesce(po.paid_out_gross,0) as gross_left
    from confirmed c
    left join refunds r on r.payment_id = c.id
    left join paidouts po on po.source_payment_id = c.id
  )
  select count(*) into v_count
  from left_now
  where gross_left > v_eps;

  return v_count;
end
$$;


--
-- Name: confirm_email_after_otp_verification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_email_after_otp_verification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Обновляем статус email_confirmed_at для пользователя в auth.users
  UPDATE auth.users
  SET email_confirmed_at = NOW()
  WHERE phone = OLD.phone
    AND email_confirmed_at IS NULL; -- Обновляем только если email еще не подтвержден

  RETURN OLD;
END;
$$;


--
-- Name: confirm_email_on_create(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.confirm_email_on_create() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  NEW.email_confirmed_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: count_alive_confirmed(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_alive_confirmed(trip_id uuid) RETURNS integer
    LANGUAGE plpgsql STABLE
    AS $_$
declare
  v_cnt int := 0;
begin
  with pp as (
    select id, amount
    from public.payments
    where trip_id = $1
      and payment_type = 'participant_payment'
      and status = 'confirmed'
  ),
  refunded as (
    select r.payment_id, coalesce(sum(r.amount),0) as refunded_sum
    from public.payment_refunds r
    where r.status = 'confirmed'
    group by r.payment_id
  )
  select count(*)
    into v_cnt
  from pp
  left join refunded r on r.payment_id = pp.id
  where coalesce(r.refunded_sum,0) < pp.amount - 0.000001;

  return v_cnt;
end $_$;


--
-- Name: count_alive_confirmed_conservative(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_alive_confirmed_conservative(p_trip_id uuid) RETURNS integer
    LANGUAGE plpgsql STABLE
    AS $$
declare
  v_cnt int := 0;
begin
  with pp as (
    select id, amount
    from public.payments
    where trip_id = p_trip_id
      and payment_type='participant_payment'
      and status='confirmed'
  ),
  conf as (
    select payment_id, sum(amount) as refunded
    from public.payment_refunds
    where status='confirmed'
    group by payment_id
  ),
  pend_close as (
    -- pending-возвраты, которые по prepare_refund_atomic помечены как "закрывающие" платёж
    select distinct payment_id
    from public.payment_refunds
    where status='pending' and will_close_payment=true
  )
  select count(*)
    into v_cnt
  from pp
  left join conf c on c.payment_id=pp.id
  left join pend_close pc on pc.payment_id=pp.id
  where coalesce(c.refunded,0) < pp.amount - 0.000001
    and pc.payment_id is null;  -- если есть pending закрывающий, считаем НЕ живым

  return v_cnt;
end $$;


--
-- Name: count_unread_messages(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_unread_messages(p_chat_id uuid, p_user_id uuid) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
  select count(*)::int
  from public.chat_messages m
  where m.chat_id = p_chat_id
    and m.user_id <> p_user_id
    and not exists (
      select 1
      from public.chat_message_reads r
      where r.message_id = m.id
        and r.user_id = p_user_id
    );
$$;


--
-- Name: find_user_by_phone(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.find_user_by_phone(p_phone text) RETURNS TABLE(id uuid, email text, phone text, email_confirmed_at timestamp with time zone, phone_confirmed_at timestamp with time zone)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'auth'
    AS $$
  select id, email, phone, email_confirmed_at, phone_confirmed_at
  from auth.users
  where phone = p_phone
  limit 1;
$$;


--
-- Name: get_active_trips_geojson(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_active_trips_geojson() RETURNS TABLE(id uuid, title text, description text, date date, "time" text, arrival_date date, arrival_time text, price numeric, difficulty text, age_from numeric, age_to numeric, from_location json, to_location json, image_urls jsonb, participants integer, leisure_type text, status text, creator_id uuid)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.title,
    t.description,
    t.date,
    t.time,
    t.arrival_date,
    t.arrival_time,
    t.price,
    t.difficulty,
    t.age_from,
    t.age_to,
    ST_AsGeoJSON(t.from_location)::json AS from_location, -- Оставляем как json
    ST_AsGeoJSON(t.to_location)::json AS to_location,     -- Оставляем как json
    t.image_urls, -- Уже jsonb, приведение не требуется
    t.participants,
    t.leisure_type,
    t.status,
    t.creator_id
  FROM trips t
  WHERE t.status = 'active';
END;
$$;


--
-- Name: get_trip_details_geojson(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_trip_details_geojson(trip_id uuid) RETURNS TABLE(id uuid, title text, description text, date date, "time" text, arrival_date date, arrival_time text, price numeric, difficulty text, age_from numeric, age_to numeric, from_location json, to_location json, image_urls jsonb, participants integer, leisure_type text, status text, creator_id uuid, from_address text, to_address text)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    t.id,
    t.title,
    t.description,
    t.date::date,
    t.time,
    t.arrival_date::date,
    t.arrival_time,
    t.price::numeric,
    t.difficulty,
    t.age_from::numeric,
    t.age_to::numeric,
    ST_AsGeoJSON(t.from_location)::json AS from_location,
    ST_AsGeoJSON(t.to_location)::json   AS to_location,
    t.image_urls,
    t.participants,
    t.leisure_type,
    t.status,
    t.creator_id,
    t.from_address,
    t.to_address
  FROM public.trips t
  WHERE t.id = trip_id;   -- ✅ убрали ограничение по статусу
END;
$$;


--
-- Name: get_trip_participants_with_details(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_trip_participants_with_details(trip_uuid uuid) RETURNS TABLE(id uuid, user_id uuid, status text, joined_at timestamp with time zone, avatar_url text, birth_date date, last_name text, first_name text, patronymic text, gender text, average_rating numeric, confirmed_start boolean, approved_trip boolean)
    LANGUAGE sql STABLE
    AS $$
  select
    tp.id,
    tp.user_id,
    tp.status,
    tp.joined_at,
    p.avatar_url,
    p.birth_date,
    p.last_name,
    p.first_name,
    p.patronymic,
    p.gender,
    coalesce((
      select avg(r.rating)::numeric(3,1)
      from reviews r
      where r.reviewer_id = tp.user_id
    ), 0) as average_rating,
    coalesce(tp.confirmed_start, false) as confirmed_start,
    tp.approved_trip
  from public.trip_participants tp
  left join public.profiles p on p.user_id = tp.user_id
  where tp.trip_id = trip_uuid
  order by tp.joined_at asc, tp.id asc;
$$;


--
-- Name: get_unread_counts_for_chats(uuid[], uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_unread_counts_for_chats(p_chat_ids uuid[], p_user_id uuid) RETURNS TABLE(chat_id uuid, unread_count bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- защита от чтения чужих данных
  if p_user_id is null or p_user_id <> auth.uid() then
    raise exception 'forbidden';
  end if;

  return query
  select
    m.chat_id,
    count(*)::bigint as unread_count
  from public.chat_messages m
  where
    m.chat_id = any(p_chat_ids)
    and m.user_id <> p_user_id
    -- защита от "угадывания" чужих chat_id
    and exists (
      select 1
      from public.chat_participants cp
      where cp.chat_id = m.chat_id
        and cp.user_id = p_user_id
    )
    -- непрочитано = нет квитанции прочтения конкретного юзера
    and not exists (
      select 1
      from public.chat_message_reads r
      where r.message_id = m.id
        and r.user_id = p_user_id
    )
  group by m.chat_id;
end;
$$;


--
-- Name: get_user_trips(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_trips(user_uuid uuid) RETURNS TABLE(id uuid, title text, description text, date date, "time" text, arrival_date date, arrival_time text, price numeric, difficulty text, age_from numeric, age_to numeric, from_location public.geography, to_location public.geography, image_urls jsonb, participants integer, leisure_type text, status text, creator_id uuid, participant_status text, participant_user_id uuid)
    LANGUAGE plpgsql
    AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (t.id)
         t.id,
         t.title,
         t.description,
         t.date,
         t.time,
         t.arrival_date,
         t.arrival_time,
         t.price,
         t.difficulty,
         t.age_from,
         t.age_to,
         t.from_location,
         t.to_location,
         t.image_urls,
         t.participants,
         t.leisure_type,
         t.status,
         t.creator_id,
         tp.status AS participant_status,
         tp.user_id AS participant_user_id -- Добавляем user_id
  FROM trips t
  LEFT JOIN trip_participants tp ON t.id = tp.trip_id
  WHERE t.creator_id = user_uuid
     OR tp.user_id = user_uuid;
END;
$$;


--
-- Name: inc_trip_cancel_progress(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.inc_trip_cancel_progress(batch_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
begin
  update trip_cancellations
  set refund_progress = coalesce(refund_progress,0) + 1,
      updated_at = now()
  where id = batch_id;
end;
$$;


--
-- Name: is_user_admin(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_user_admin() RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  RETURN (
    SELECT is_admin
    FROM profiles
    WHERE user_id = auth.uid()
    LIMIT 1
  );
END;
$$;


--
-- Name: mark_chat_read(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_chat_read(p_chat_id uuid, p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  -- 1) совместимость: read=true
  update public.chat_messages m
    set read = true
  where m.chat_id = p_chat_id
    and m.user_id <> p_user_id
    and (m.read is null or m.read = false);

  -- 2) главное: квитанции всем сообщениям, где их нет
  insert into public.chat_message_reads (message_id, user_id, read_at)
  select m.id, p_user_id, now()
  from public.chat_messages m
  where m.chat_id = p_chat_id
    and m.user_id <> p_user_id
    and not exists (
      select 1
      from public.chat_message_reads r
      where r.message_id = m.id
        and r.user_id = p_user_id
    )
  on conflict (message_id, user_id)
  do update set read_at = excluded.read_at;
end;
$$;


--
-- Name: mark_leaver_msgs_read_for_organizer(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_leaver_msgs_read_for_organizer(p_trip_id uuid, p_leaver_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_org uuid;
begin
  select creator_id into v_org
  from trips
  where id = p_trip_id;

  if v_org is null then
    return;
  end if;

  insert into chat_message_reads (message_id, user_id, chat_id, read_at)
  select m.id, v_org, m.chat_id, now()
  from chat_messages m
  join chats c on c.id = m.chat_id
  where c.trip_id = p_trip_id
    and c.is_group = false
    and c.chat_type in ('trip_private', 'archived')
    and m.user_id = p_leaver_id
  on conflict (message_id, user_id) do update
    set read_at = excluded.read_at,
        chat_id = coalesce(excluded.chat_id, chat_message_reads.chat_id);
end;
$$;


--
-- Name: mark_trip_msgs_read_for_user(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_trip_msgs_read_for_user(p_trip_id uuid, p_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  insert into public.chat_message_reads (message_id, user_id, chat_id, read_at)
  select
    m.id,
    p_user_id,
    m.chat_id,
    now()
  from public.chat_messages m
  join public.chats c on c.id = m.chat_id
  where c.trip_id = p_trip_id
    and c.chat_type in ('trip_group', 'trip_private', 'archived')
    and m.user_id <> p_user_id
  on conflict (message_id, user_id) do update
    set read_at = excluded.read_at,
        chat_id = coalesce(excluded.chat_id, public.chat_message_reads.chat_id);
end;
$$;


--
-- Name: prepare_payout_atomic(uuid, uuid, numeric, numeric, numeric, uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_payout_atomic(p_trip_id uuid, p_source_payment_id uuid, p_amount_net_rub numeric, p_fee_platform_pct numeric, p_fee_tbank_pct numeric, p_participant_id uuid DEFAULT NULL::uuid, p_hint_is_final boolean DEFAULT NULL::boolean) RETURNS TABLE(order_id text, amount_kop integer, computed_is_final boolean, alive_payments integer)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
declare
  v_pay_amount_rub            numeric := 0;
  v_refunded_rub              numeric := 0;
  v_paid_out_gross_equiv_rub  numeric := 0;
  v_gross_available_rub       numeric := 0;
  v_total_pct                 numeric := 0;
  v_gross_equiv_for_request   numeric := 0;
  v_alive_after               int := 0;
  -- v_eps оставляем для совместимости в прежних местах, если где-то ещё используется
  v_eps                       numeric := 0.005;

  -- НОВОЕ: допуск сравнения в копейках (1 = 0.01 ₽)
  v_tolerance_kop             integer := 100;
begin
  if coalesce(p_amount_net_rub,0) <= 0 then
    raise exception 'PAYOUT_AMOUNT_INVALID';
  end if;

  -- общий замок по поездке (серилизация конкурирующих выплат)
  perform pg_advisory_xact_lock(hashtext(p_trip_id::text));

  -- проверяем исходный платёж
  select amount::numeric
    into v_pay_amount_rub
  from public.payments
  where id = p_source_payment_id
    and trip_id = p_trip_id
    and payment_type = 'participant_payment'
    and status = 'confirmed'
  limit 1;

  if coalesce(v_pay_amount_rub,0) <= 0 then
    raise exception 'SOURCE_PAYMENT_NOT_FOUND';
  end if;

  -- подтверждённые возвраты по этому платёжному чеку
  select coalesce(sum(amount),0)::numeric
    into v_refunded_rub
  from public.payment_refunds
  where payment_id = p_source_payment_id
    and status = 'confirmed';

  -- уже забронированные/проведённые выплаты по этому чеку (их GROSS-эквивалент)
  select coalesce(sum(amount_gross_equiv_rub),0)::numeric
    into v_paid_out_gross_equiv_rub
  from public.payout_attempts
  where source_payment_id = p_source_payment_id
    and status in ('pending','completed');

  v_gross_available_rub := greatest(v_pay_amount_rub - v_refunded_rub - v_paid_out_gross_equiv_rub, 0);

  -- переводим NET запроса в GROSS-эквивалент по снапшоту комиссий (строго вниз по копейке)
  v_total_pct := coalesce(p_fee_platform_pct,0) + coalesce(p_fee_tbank_pct,0);
  if v_total_pct >= 100 then
    raise exception 'PAYOUT_FEE_INVALID';
  end if;

  v_gross_equiv_for_request := trunc( (p_amount_net_rub / (1 - v_total_pct/100))::numeric, 2 );

  -- НОВОЕ: сравнение в копейках с допуском (избежать проблемы 1999.99 vs 2000.00)
  if trunc(v_gross_equiv_for_request * 100)::int
       > trunc(v_gross_available_rub * 100)::int + v_tolerance_kop then
    raise exception 'PAYOUT_EXCEEDS_AVAILABLE';
  end if;

  -- ↓↓↓ НОВЫЙ блок подсчёта "живых" платежей ПОСЛЕ этой брони — в копейках с допуском
  with confirmed as (
    select p.id, p.amount::numeric as gross_paid
    from public.payments p
    where p.trip_id = p_trip_id
      and p.payment_type = 'participant_payment'
      and p.status = 'confirmed'
  ),
  refunds as (
    select payment_id, coalesce(sum(amount),0)::numeric as refunded
    from public.payment_refunds
    where status = 'confirmed'
    group by payment_id
  ),
  paidouts as (
    select source_payment_id, coalesce(sum(amount_gross_equiv_rub),0)::numeric as paid_out_gross
    from public.payout_attempts
    where status in ('pending','completed')
    group by source_payment_id
  ),
  left_after as (
    select
      c.id,
      -- остаток в КОПЕЙКАХ, округлённый до ближайшей копейки
      round((
        c.gross_paid
        - coalesce(r.refunded,0)
        - coalesce(po.paid_out_gross,0)
        - case when c.id = p_source_payment_id then v_gross_equiv_for_request else 0 end
      ) * 100)::int as gross_left_kop
    from confirmed c
    left join refunds r on r.payment_id = c.id
    left join paidouts po on po.source_payment_id = c.id
  )
  select count(*) into v_alive_after
  from left_after
  -- считаем «живым» только если остаток строго больше допуска (например, > 1 коп.)
  where gross_left_kop > v_tolerance_kop;

  -- финальность: если после этой выплаты «живых» не осталось
  computed_is_final := coalesce(p_hint_is_final, v_alive_after = 0);

  -- готовим банковскую сумму (копейки) из NET (вниз)
  order_id := 'pout-' || p_trip_id || '-' || extract(epoch from clock_timestamp())::bigint;
  amount_kop := trunc(p_amount_net_rub * 100)::int;
  alive_payments := v_alive_after;

  -- бронь
  insert into public.payout_attempts (
    trip_id, participant_id, source_payment_id,
    status, attempt_count, last_attempt_at,
    amount,                 -- копейки в банк (NET)
    amount_net_rub,         -- NET, руб.
    amount_gross_equiv_rub, -- GROSS-эквивалент (для лимитов/аналитики)
    fee_platform_pct, fee_tbank_pct,
    order_id, computed_is_final
  ) values (
    p_trip_id, p_participant_id, p_source_payment_id,
    'pending', 1, now(),
    amount_kop,
    p_amount_net_rub,
    v_gross_equiv_for_request,
    p_fee_platform_pct, p_fee_tbank_pct,
    order_id, computed_is_final
  );

  return next;
end
$$;


--
-- Name: prepare_refund_atomic(uuid, uuid, uuid, numeric, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prepare_refund_atomic(p_payment_id uuid, p_trip_id uuid, p_participant_id uuid, p_amount_rub numeric, p_external_request_id text, p_reason text, p_created_by uuid) RETURNS TABLE(refund_row_id uuid, will_close boolean)
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_payment_amount_rub numeric;  -- сумма исходного платежа участника (₽)
  v_reserved_rub numeric;        -- уже зарезервировано (₽) pending+confirmed
  v_row_id uuid;
BEGIN
  -- транзакционная блокировка по поездке
  PERFORM pg_advisory_xact_lock(hashtext(p_trip_id::text));

  -- подтверждённый платёж участника в этой поездке
  SELECT amount
  INTO v_payment_amount_rub
  FROM public.payments
  WHERE id = p_payment_id
    AND trip_id = p_trip_id
    AND participant_id = p_participant_id
    AND payment_type = 'participant_payment'
    AND status = 'confirmed'
  FOR UPDATE;

  IF v_payment_amount_rub IS NULL THEN
    RAISE EXCEPTION 'PAYMENT_NOT_FOUND';
  END IF;

  IF COALESCE(p_amount_rub, 0) <= 0 THEN
    RAISE EXCEPTION 'INVALID_AMOUNT';
  END IF;

  -- уже зарезервировано (₽) по этому платежу
  SELECT COALESCE(SUM(amount), 0)
  INTO v_reserved_rub
  FROM public.payment_refunds
  WHERE payment_id = p_payment_id
    AND status IN ('pending','confirmed');

  IF v_reserved_rub + p_amount_rub > v_payment_amount_rub THEN
    RAISE EXCEPTION 'REFUND_EXCEEDS_AVAILABLE';
  END IF;

  -- ИДЕМПОТЕНТНО: создаём/обновляем бронь возврата по (trip_id, external_request_id)
  INSERT INTO public.payment_refunds (
    trip_id, participant_id, payment_id,
    amount, status, external_request_id, reason, created_by
  )
  VALUES (
    p_trip_id, p_participant_id, p_payment_id,
    p_amount_rub, 'pending', p_external_request_id, p_reason, p_created_by
  )
  ON CONFLICT (trip_id, external_request_id)
  DO UPDATE SET
    amount      = EXCLUDED.amount,
    reason      = EXCLUDED.reason,
    status      = 'pending',
    updated_at  = NOW()
  RETURNING id INTO v_row_id;

  -- Для Cancel не считаем автозакрытие — вернём false
  RETURN QUERY SELECT v_row_id, FALSE::boolean;
END;
$$;


--
-- Name: send_push_notification(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_push_notification() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  recipient_id uuid;
BEGIN
  SELECT CASE
    WHEN NEW.user_id = user_id_1 THEN user_id_2
    ELSE user_id_1
  END INTO recipient_id
  FROM chats
  WHERE id = NEW.chat_id
  LIMIT 1;

  PERFORM net.http_post(
    'https://newtest.onloc.ru/api/push',
    jsonb_build_object(
      'userId', recipient_id,
      'title', 'Новое сообщение',
      'body', NEW.content
    ),
    '{"Content-Type":"application/json"}'::jsonb,
    '{}'::jsonb,
    5000
  );
  RETURN NEW;
END;
$$;


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$ begin new.updated_at = now(); return new; end $$;


--
-- Name: trg_payment_refunds_after_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_payment_refunds_after_change() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  v_payment_amount numeric := 0;
  v_total_refunded numeric := 0;
begin
  -- интересуют только строки, ставшие confirmed
  if tg_op = 'INSERT' then
    if new.status <> 'confirmed' then
      return new;
    end if;
  else
    if not (new.status = 'confirmed' and (old.status is distinct from new.status)) then
      if new.status <> 'confirmed' then
        return new;
      end if;
    end if;
  end if;

  select amount into v_payment_amount
  from public.payments
  where id = new.payment_id
  limit 1;

  if v_payment_amount is null then
    raise exception 'PAYMENT_NOT_FOUND for payment_id=%', new.payment_id;
  end if;

  select coalesce(sum(amount), 0) into v_total_refunded
  from public.payment_refunds
  where payment_id = new.payment_id
    and status = 'confirmed';

  if v_total_refunded > v_payment_amount + 0.000001 then
    raise exception 'REFUND_SUM_EXCEEDS_PAYMENT (refunded=%, payment=%)', v_total_refunded, v_payment_amount;
  end if;

  if v_total_refunded >= v_payment_amount - 0.000001 then
    update public.payments
       set status = 'refunded',
           is_refunded = true,
           refunded_at = now(),
           updated_at = now()
     where id = new.payment_id;
  end if;

  return new;
end $$;


--
-- Name: trg_payment_refunds_set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trg_payment_refunds_set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at = now();
  return new;
end $$;


--
-- Name: update_email_verified(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_email_verified() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE auth.users
  SET email_verified = true
  WHERE email = 'user_' || NEW.phone || '@example.com';
  RETURN NEW;
END;
$$;


--
-- Name: update_expired_trips_status(); Type: PROCEDURE; Schema: public; Owner: -
--

CREATE PROCEDURE public.update_expired_trips_status()
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE trips t
  SET status = 'canceled'
  WHERE t.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM trip_participants tp
      WHERE tp.trip_id = t.id
        AND tp.status IN ('waiting', 'confirmed')
    )
    AND (t.date + (t.time || ':00')::time) < NOW();
END;
$$;


--
-- Name: update_trip_status(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_trip_status() RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  UPDATE trips
  SET status = 'started'
  WHERE status = 'active'
    AND start_date <= NOW();
END;
$$;


--
-- Name: update_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;


--
-- Name: verify_phone_otp(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verify_phone_otp(phone_number text, input_otp text) RETURNS json
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  temp_otp_record record;
  user_record record;
BEGIN
  -- Проверяем, есть ли пользователь с таким номером телефона
  SELECT * INTO user_record
  FROM auth.users
  WHERE phone = phone_number;

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'User not found');
  END IF;

  -- Проверяем OTP
  SELECT * INTO temp_otp_record
  FROM temp_otps
  WHERE phone = phone_number AND otp = input_otp AND expires_at > NOW();

  IF NOT FOUND THEN
    RETURN json_build_object('success', false, 'error', 'Invalid or expired OTP');
  END IF;

  -- Удаляем OTP после успешной верификации (это вызовет триггер)
  DELETE FROM temp_otps WHERE phone = phone_number;

  RETURN json_build_object('success', true);
END;
$$;


--
-- Name: verify_user_email(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verify_user_email() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'auth', 'pg_catalog'
    AS $$
BEGIN
  IF NEW.verified = TRUE AND OLD.verified = FALSE AND NEW.is_registration = TRUE THEN
    UPDATE auth.users
    SET email_confirmed_at = NOW()
    WHERE phone = NEW.phone;

    RAISE NOTICE 'Email verified for phone: % (registration)', NEW.phone;
  END IF;

  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: bank_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bank_cards (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    card_id text NOT NULL,
    last_four_digits text NOT NULL,
    expiry_date text,
    is_primary boolean DEFAULT false,
    status text DEFAULT 'active'::text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: chat_message_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_message_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id integer NOT NULL,
    bucket text NOT NULL,
    path text NOT NULL,
    mime text,
    size bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: chat_message_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_message_reads (
    message_id integer NOT NULL,
    user_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL,
    chat_id uuid
);

ALTER TABLE ONLY public.chat_message_reads REPLICA IDENTITY FULL;


--
-- Name: chat_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_messages (
    id integer NOT NULL,
    user_id uuid,
    content text,
    created_at timestamp with time zone DEFAULT now(),
    chat_id uuid NOT NULL,
    read boolean DEFAULT false
);

ALTER TABLE ONLY public.chat_messages REPLICA IDENTITY FULL;


--
    tbank_tools boolean DEFAULT false NOT NULL,
-- Name: chat_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.chat_messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: chat_messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.chat_messages_id_seq OWNED BY public.chat_messages.id;


--
-- Name: chat_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chat_participants (
    chat_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT now()
);


--
-- Name: chats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.chats (
    title text,
    user_id_1 uuid,
    user_id_2 uuid,
    created_at timestamp with time zone DEFAULT now(),
    trip_id uuid,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_type text DEFAULT 'support'::text NOT NULL,
    moderator_id uuid,
    is_group boolean DEFAULT false NOT NULL,
    support_close_requested_at timestamp with time zone,
    support_close_confirmed boolean,
    CONSTRAINT chats_chat_type_check CHECK ((chat_type = ANY (ARRAY['support'::text, 'dispute'::text, 'trip_group'::text, 'trip_private'::text, 'archived'::text, 'company_edit'::text])))
);


--
-- Name: company_reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_reviews (
    id integer NOT NULL,
    organizer_id uuid NOT NULL,
    rating integer NOT NULL,
    text text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    trip_id uuid NOT NULL,
    reviewer_id uuid NOT NULL
);


--
-- Name: TABLE company_reviews; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.company_reviews IS 'Таблица для хранения отзывов о поездках, созданных компаниями (is_company_trip = true)';


--
-- Name: COLUMN company_reviews.id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.company_reviews.id IS 'Уникальный идентификатор отзыва';


--
-- Name: COLUMN company_reviews.organizer_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.company_reviews.organizer_id IS 'Идентификатор организатора поездки (ссылка на profiles.user_id)';


--
-- Name: COLUMN company_reviews.rating; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.company_reviews.rating IS 'Рейтинг поездки (число)';


--
-- Name: COLUMN company_reviews.text; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.company_reviews.text IS 'Текст отзыва';


--
-- Name: COLUMN company_reviews.created_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.company_reviews.created_at IS 'Дата и время создания отзыва';


--
-- Name: COLUMN company_reviews.trip_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.company_reviews.trip_id IS 'Идентификатор поездки (ссылка на trips.id)';


--
-- Name: COLUMN company_reviews.reviewer_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.company_reviews.reviewer_id IS 'Идентификатор рецензента (ссылка на profiles.user_id)';


--
-- Name: company_reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.company_reviews ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.company_reviews_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: dispute_close_proposals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispute_close_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    chat_id uuid NOT NULL,
    trip_id uuid NOT NULL,
    moderator_id uuid NOT NULL,
    proposal_text text NOT NULL,
    initiator_id uuid NOT NULL,
    organizer_id uuid NOT NULL,
    initiator_confirmed boolean DEFAULT false NOT NULL,
    organizer_confirmed boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_at timestamp with time zone
);


--
-- Name: dispute_evidences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.dispute_evidences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    dispute_id uuid NOT NULL,
    file_url text NOT NULL,
    uploaded_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: disputes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.disputes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trip_id uuid NOT NULL,
    initiator_id uuid NOT NULL,
    respondent_id uuid NOT NULL,
    reason text NOT NULL,
    status text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    close_proposal_text text,
    close_proposal_at timestamp with time zone,
    initiator_confirmed boolean DEFAULT false NOT NULL,
    respondent_confirmed boolean DEFAULT false NOT NULL,
    confirmed_at timestamp with time zone,
    locked boolean DEFAULT false NOT NULL,
    refund_amount_cents integer,
    payout_amount_cents integer,
    CONSTRAINT disputes_status_check CHECK ((status = ANY (ARRAY['awaiting_moderator'::text, 'in_progress'::text, 'resolved'::text, 'error'::text])))
);


--
-- Name: map_search; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.map_search (
    id integer NOT NULL,
    query character varying(255),
    results jsonb,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: map_search_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.map_search_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: map_search_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.map_search_id_seq OWNED BY public.map_search.id;


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id integer NOT NULL,
    chat_id integer,
    sender_id uuid,
    content text NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.messages_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: messages_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.messages_id_seq OWNED BY public.messages.id;


--
-- Name: mycompany; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mycompany (
    company_id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid,
    name text NOT NULL,
    inn text NOT NULL,
    kpp text,
    legal_address text,
    phone text,
    account text,
    payment_account text,
    payment_bik text,
    payment_corr_account text,
    okveds jsonb,
    avatar_url text,
    verified boolean DEFAULT false,
    status text DEFAULT 'unknown'::text,
    ogrn text,
    created_at timestamp with time zone DEFAULT now(),
    is_active boolean DEFAULT true,
    tbank_registered boolean DEFAULT false,
    tbank_shop_code text,
    okved_update_pending boolean DEFAULT false,
    okved_update_file text,
    ceo_first_name text,
    ceo_last_name text,
    ceo_middle_name text,
    site_url text DEFAULT '''https://onloc.ru''::text'::text,
    bank_name text,
    payment_details text,
    terminal_key text,
    terminal_secret text,
    tbank_code text
);


--
-- Name: COLUMN mycompany.tbank_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.mycompany.tbank_code IS 'Article code (партнёрский идентификатор точки) из ответа /sm-register/register';


--
-- Name: payment_refunds; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payment_refunds (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    payment_id uuid NOT NULL,
    trip_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    amount numeric NOT NULL,
    status text NOT NULL,
    refund_id text,
    reason text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    updated_at timestamp with time zone,
    external_request_id text,
    will_close_payment boolean DEFAULT false NOT NULL,
    CONSTRAINT payment_refunds_amount_check CHECK ((amount > (0)::numeric)),
    CONSTRAINT payment_refunds_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'failed'::text])))
);


--
-- Name: payments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    trip_id uuid NOT NULL,
    participant_id uuid NOT NULL,
    amount numeric NOT NULL,
    status text NOT NULL,
    payment_id text,
    payment_type text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    deal_id text,
    card_id text,
    updated_at timestamp with time zone,
    order_id text NOT NULL,
    is_authorized boolean DEFAULT false,
    is_confirmed boolean DEFAULT false,
    is_refunded boolean DEFAULT false,
    payout_completed boolean DEFAULT false,
    payout_at timestamp with time zone,
    locked_until timestamp with time zone,
    refunded_at timestamp with time zone,
    CONSTRAINT payments_payment_type_check CHECK ((payment_type = ANY (ARRAY['participant_payment'::text, 'organizer_payout'::text]))),
    CONSTRAINT payments_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'refunded'::text])))
);


--
-- Name: payout_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payout_attempts (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    trip_id uuid,
    participant_id uuid,
    status character varying(20),
    attempt_count integer DEFAULT 1,
    last_attempt_at timestamp with time zone,
    error_message text,
    amount integer,
    payment_id text,
    created_at timestamp with time zone DEFAULT now(),
    order_id text,
    external_order_id text,
    bank_order_id text,
    source_payment_id uuid,
    fee_platform_pct numeric(6,3),
    fee_tbank_pct numeric(6,3),
    amount_net_rub numeric,
    amount_gross_equiv_rub numeric,
    computed_is_final boolean,
    bank_status text,
    bank_error_code text,
    bank_message text,
    bank_payload jsonb,
    CONSTRAINT payout_attempts_external_order_id_len CHECK (((external_order_id IS NULL) OR (char_length(external_order_id) <= 50))),
    CONSTRAINT payout_attempts_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('completed'::character varying)::text, ('failed'::character varying)::text])))
);


--
-- Name: COLUMN payout_attempts.external_order_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.payout_attempts.external_order_id IS 'OrderId actually sent to T-Bank (<=50 chars)';


--
-- Name: payout_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.payout_logs (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    trip_id uuid,
    action character varying(50),
    details jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    user_id uuid NOT NULL,
    birth_date date,
    location text,
    geo_lat text,
    geo_lon text,
    about text,
    created_at timestamp with time zone DEFAULT now(),
    avatar_url text,
    vk_id text,
    phone text,
    first_name text,
    last_name text,
    patronymic text,
    gender text,
    email text,
    phone_verified boolean DEFAULT false,
    email_verified boolean DEFAULT false,
    is_admin boolean DEFAULT false
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id bigint NOT NULL,
    user_id uuid,
    subscription jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: push_subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.push_subscriptions ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.push_subscriptions_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: realtime_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.realtime_subscriptions (
    id integer NOT NULL,
    user_id uuid,
    table_name character varying(255) NOT NULL,
    event_type character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: realtime_subscriptions_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.realtime_subscriptions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: realtime_subscriptions_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.realtime_subscriptions_id_seq OWNED BY public.realtime_subscriptions.id;


--
-- Name: reviews; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reviews (
    id integer NOT NULL,
    organizer_id uuid,
    rating integer,
    text text,
    created_at timestamp with time zone DEFAULT now(),
    trip_id uuid,
    reviewer_id uuid,
    CONSTRAINT reviews_rating_check CHECK (((rating >= 1) AND (rating <= 5)))
);


--
-- Name: reviews_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.reviews_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: reviews_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.reviews_id_seq OWNED BY public.reviews.id;


--
-- Name: temp_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temp_otps (
    phone text NOT NULL,
    otp text NOT NULL,
    expires_at timestamp without time zone NOT NULL,
    call_id text
);


--
-- Name: temp_verifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.temp_verifications (
    phone text NOT NULL,
    call_id text,
    expires_at timestamp with time zone NOT NULL,
    verified boolean DEFAULT false,
    is_registration boolean DEFAULT false
);


--
-- Name: travels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.travels (
    id integer NOT NULL,
    title character varying(255) NOT NULL,
    description text,
    user_id uuid,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: travels_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.travels_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: travels_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.travels_id_seq OWNED BY public.travels.id;


--
-- Name: trip_cancellations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_cancellations (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    trip_id uuid,
    status character varying(20) NOT NULL,
    refund_progress integer DEFAULT 0,
    total_refunds integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: trip_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trip_participants (
    user_id uuid,
    status text,
    joined_at timestamp with time zone DEFAULT now(),
    trip_id uuid,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    confirmed_start boolean DEFAULT false,
    approved_trip boolean
);


--
-- Name: trips; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trips (
    title text NOT NULL,
    description text,
    date date,
    "time" text,
    arrival_date date,
    arrival_time text,
    price numeric,
    difficulty text,
    age_from numeric,
    age_to numeric,
    participants integer,
    creator_id uuid,
    status text,
    created_at timestamp with time zone DEFAULT now(),
    from_location public.geography(Point,4326),
    to_location public.geography(Point,4326),
    leisure_type text,
    image_urls jsonb,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    is_company_trip boolean DEFAULT false,
    alcohol_allowed boolean DEFAULT false,
    from_address text DEFAULT ''::text,
    to_address text DEFAULT ''::text,
    timezone text,
    refund_policy jsonb,
    start_date timestamp with time zone,
    deal_id text,
    platform_fee numeric,
    tbank_fee numeric,
    net_amount numeric,
    dispute_period_ends_at timestamp with time zone
);


--
-- Name: user_admin_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_admin_access (
    user_id uuid NOT NULL,
    is_admin boolean DEFAULT false NOT NULL,
    disputes boolean DEFAULT false NOT NULL,
    chats boolean DEFAULT false NOT NULL,
    trips boolean DEFAULT false NOT NULL,
    profiles boolean DEFAULT false NOT NULL,
    reviews boolean DEFAULT false NOT NULL,
    companies boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE user_admin_access; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_admin_access IS 'Документ доступы пользователя (только чтение пользователям)';


--
-- Name: user_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_cards (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid,
    card_id text NOT NULL,
    last_four_digits text NOT NULL,
    expiry_date text,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    is_primary boolean DEFAULT false,
    card_scope text,
    CONSTRAINT user_cards_card_scope_check CHECK ((card_scope = ANY (ARRAY['payment'::text, 'payout'::text])))
);


--
-- Name: user_pay_cards; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.user_pay_cards AS
 SELECT user_cards.id,
    user_cards.user_id,
    user_cards.card_id,
    user_cards.last_four_digits,
    user_cards.expiry_date,
    user_cards.created_at,
    user_cards.is_primary,
    user_cards.card_scope
   FROM public.user_cards
  WHERE (user_cards.card_scope = 'payment'::text);


--
-- Name: user_payout_cards; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.user_payout_cards AS
 SELECT user_cards.id,
    user_cards.user_id,
    user_cards.card_id,
    user_cards.last_four_digits,
    user_cards.expiry_date,
    user_cards.created_at,
    user_cards.is_primary,
    user_cards.card_scope
   FROM public.user_cards
  WHERE (user_cards.card_scope = 'payout'::text);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    email character varying(255) NOT NULL,
    password character varying(255) NOT NULL,
    created_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: v_trip_money; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_trip_money AS
 SELECT t.id AS trip_id,
    COALESCE(sum(
        CASE
            WHEN ((p.payment_type = 'participant_payment'::text) AND (p.status = 'confirmed'::text)) THEN p.amount
            ELSE (0)::numeric
        END), (0)::numeric) AS incoming_confirmed_rub,
    COALESCE(( SELECT sum(r.amount) AS sum
           FROM public.payment_refunds r
          WHERE ((r.trip_id = t.id) AND (r.status = 'confirmed'::text))), (0)::numeric) AS refunds_rub,
    COALESCE(sum(
        CASE
            WHEN ((p.payment_type = 'organizer_payout'::text) AND (p.payout_completed IS TRUE)) THEN p.amount
            ELSE (0)::numeric
        END), (0)::numeric) AS payouts_rub,
    ((COALESCE(sum(
        CASE
            WHEN ((p.payment_type = 'participant_payment'::text) AND (p.status = 'confirmed'::text)) THEN p.amount
            ELSE (0)::numeric
        END), (0)::numeric) - COALESCE(( SELECT sum(r2.amount) AS sum
           FROM public.payment_refunds r2
          WHERE ((r2.trip_id = t.id) AND (r2.status = 'confirmed'::text))), (0)::numeric)) - COALESCE(sum(
        CASE
            WHEN ((p.payment_type = 'organizer_payout'::text) AND (p.payout_completed IS TRUE)) THEN p.amount
            ELSE (0)::numeric
        END), (0)::numeric)) AS available_rub
   FROM (public.trips t
     LEFT JOIN public.payments p ON ((p.trip_id = t.id)))
  GROUP BY t.id;


--
-- Name: v_trip_money_conservative; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_trip_money_conservative AS
 WITH incoming AS (
         SELECT payments.trip_id,
            sum(payments.amount) AS amt
           FROM public.payments
          WHERE ((payments.payment_type = 'participant_payment'::text) AND (payments.status = 'confirmed'::text))
          GROUP BY payments.trip_id
        ), refunds_confirmed AS (
         SELECT payment_refunds.trip_id,
            sum(payment_refunds.amount) AS amt
           FROM public.payment_refunds
          WHERE (payment_refunds.status = 'confirmed'::text)
          GROUP BY payment_refunds.trip_id
        ), refunds_pending AS (
         SELECT payment_refunds.trip_id,
            sum(payment_refunds.amount) AS amt
           FROM public.payment_refunds
          WHERE (payment_refunds.status = 'pending'::text)
          GROUP BY payment_refunds.trip_id
        ), payouts_completed AS (
         SELECT payout_attempts.trip_id,
            sum(payout_attempts.amount) AS amt_kop
           FROM public.payout_attempts
          WHERE ((payout_attempts.status)::text = 'completed'::text)
          GROUP BY payout_attempts.trip_id
        ), payouts_pending AS (
         SELECT payout_attempts.trip_id,
            sum(payout_attempts.amount) AS amt_kop
           FROM public.payout_attempts
          WHERE ((payout_attempts.status)::text = 'pending'::text)
          GROUP BY payout_attempts.trip_id
        )
 SELECT t.id AS trip_id,
    COALESCE(i.amt, (0)::numeric) AS incoming_rub,
    COALESCE(rc.amt, (0)::numeric) AS refunds_confirmed_rub,
    COALESCE(rp.amt, (0)::numeric) AS refunds_pending_rub,
    COALESCE(pc.amt_kop, (0)::bigint) AS payouts_completed_kop,
    COALESCE(pp.amt_kop, (0)::bigint) AS payouts_pending_kop,
    (((((round((COALESCE(i.amt, (0)::numeric) * (100)::numeric)))::bigint - (round((COALESCE(rc.amt, (0)::numeric) * (100)::numeric)))::bigint) - (round((COALESCE(rp.amt, (0)::numeric) * (100)::numeric)))::bigint) - COALESCE(pc.amt_kop, (0)::bigint)) - COALESCE(pp.amt_kop, (0)::bigint)) AS available_kop_conservative
   FROM (((((public.trips t
     LEFT JOIN incoming i ON ((i.trip_id = t.id)))
     LEFT JOIN refunds_confirmed rc ON ((rc.trip_id = t.id)))
     LEFT JOIN refunds_pending rp ON ((rp.trip_id = t.id)))
     LEFT JOIN payouts_completed pc ON ((pc.trip_id = t.id)))
     LEFT JOIN payouts_pending pp ON ((pp.trip_id = t.id)));


--
-- Name: chat_messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages ALTER COLUMN id SET DEFAULT nextval('public.chat_messages_id_seq'::regclass);


--
-- Name: map_search id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_search ALTER COLUMN id SET DEFAULT nextval('public.map_search_id_seq'::regclass);


--
-- Name: messages id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages ALTER COLUMN id SET DEFAULT nextval('public.messages_id_seq'::regclass);


--
-- Name: realtime_subscriptions id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_subscriptions ALTER COLUMN id SET DEFAULT nextval('public.realtime_subscriptions_id_seq'::regclass);


--
-- Name: reviews id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews ALTER COLUMN id SET DEFAULT nextval('public.reviews_id_seq'::regclass);


--
-- Name: travels id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travels ALTER COLUMN id SET DEFAULT nextval('public.travels_id_seq'::regclass);


--
-- Name: bank_cards bank_cards_card_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_cards
    ADD CONSTRAINT bank_cards_card_id_key UNIQUE (card_id);


--
-- Name: bank_cards bank_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_cards
    ADD CONSTRAINT bank_cards_pkey PRIMARY KEY (id);


--
-- Name: chat_message_files chat_message_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_message_files
    ADD CONSTRAINT chat_message_files_pkey PRIMARY KEY (id);


--
-- Name: chat_message_reads chat_message_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_message_reads
    ADD CONSTRAINT chat_message_reads_pkey PRIMARY KEY (message_id, user_id);


--
-- Name: chat_messages chat_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_pkey PRIMARY KEY (id);


--
-- Name: chat_participants chat_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_participants
    ADD CONSTRAINT chat_participants_pkey PRIMARY KEY (chat_id, user_id);

ALTER TABLE ONLY public.chat_participants REPLICA IDENTITY USING INDEX chat_participants_pkey;


--
-- Name: chats chats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chats
    ADD CONSTRAINT chats_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.chats REPLICA IDENTITY USING INDEX chats_pkey;


--
-- Name: company_reviews company_reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_reviews
    ADD CONSTRAINT company_reviews_pkey PRIMARY KEY (id);


--
-- Name: dispute_close_proposals dispute_close_proposals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispute_close_proposals
    ADD CONSTRAINT dispute_close_proposals_pkey PRIMARY KEY (id);


--
-- Name: dispute_evidences dispute_evidences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispute_evidences
    ADD CONSTRAINT dispute_evidences_pkey PRIMARY KEY (id);


--
-- Name: disputes disputes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_pkey PRIMARY KEY (id);


--
-- Name: map_search map_search_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.map_search
    ADD CONSTRAINT map_search_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: mycompany mycompany_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mycompany
    ADD CONSTRAINT mycompany_pkey PRIMARY KEY (company_id);


--
-- Name: payment_refunds payment_refunds_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_pkey PRIMARY KEY (id);


--
-- Name: payments payments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_pkey PRIMARY KEY (id);


--
-- Name: payout_attempts payout_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_attempts
    ADD CONSTRAINT payout_attempts_pkey PRIMARY KEY (id);


--
-- Name: payout_logs payout_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_logs
    ADD CONSTRAINT payout_logs_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_email_key UNIQUE (email);


--
-- Name: profiles profiles_phone_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_phone_key UNIQUE (phone);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (user_id);


--
-- Name: profiles profiles_vk_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_vk_id_key UNIQUE (vk_id);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: realtime_subscriptions realtime_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_subscriptions
    ADD CONSTRAINT realtime_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: reviews reviews_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_pkey PRIMARY KEY (id);


--
-- Name: temp_otps temp_otps_phone_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temp_otps
    ADD CONSTRAINT temp_otps_phone_unique UNIQUE (phone);


--
-- Name: temp_otps temp_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temp_otps
    ADD CONSTRAINT temp_otps_pkey PRIMARY KEY (phone);


--
-- Name: temp_verifications temp_verifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.temp_verifications
    ADD CONSTRAINT temp_verifications_pkey PRIMARY KEY (phone);


--
-- Name: travels travels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travels
    ADD CONSTRAINT travels_pkey PRIMARY KEY (id);


--
-- Name: trip_cancellations trip_cancellations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_cancellations
    ADD CONSTRAINT trip_cancellations_pkey PRIMARY KEY (id);


--
-- Name: trip_participants trip_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_participants
    ADD CONSTRAINT trip_participants_pkey PRIMARY KEY (id);


--
-- Name: trips trips_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_pkey PRIMARY KEY (id);


--
-- Name: trip_participants unique_trip_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_participants
    ADD CONSTRAINT unique_trip_user UNIQUE (trip_id, user_id);


--
-- Name: payment_refunds uq_refunds_trip_extreq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT uq_refunds_trip_extreq UNIQUE (trip_id, external_request_id);


--
-- Name: user_admin_access user_admin_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_admin_access
    ADD CONSTRAINT user_admin_access_pkey PRIMARY KEY (user_id);

ALTER TABLE ONLY public.user_admin_access REPLICA IDENTITY USING INDEX user_admin_access_pkey;


--
-- Name: user_cards user_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cards
    ADD CONSTRAINT user_cards_pkey PRIMARY KEY (id);


--
-- Name: users users_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_email_key UNIQUE (email);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: chat_message_files_message_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_message_files_message_id_idx ON public.chat_message_files USING btree (message_id);


--
-- Name: chat_message_reads_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_message_reads_message_idx ON public.chat_message_reads USING btree (message_id);


--
-- Name: chat_message_reads_msg_readat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_message_reads_msg_readat_idx ON public.chat_message_reads USING btree (message_id, read_at DESC);


--
-- Name: chat_message_reads_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_message_reads_user_idx ON public.chat_message_reads USING btree (user_id);


--
-- Name: chat_messages_chat_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_chat_created_idx ON public.chat_messages USING btree (chat_id, created_at DESC);


--
-- Name: chat_messages_unread_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_messages_unread_idx ON public.chat_messages USING btree (chat_id) WHERE ((read IS NULL) OR (read = false));


--
-- Name: chat_participants_chat_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_participants_chat_id_idx ON public.chat_participants USING btree (chat_id);


--
-- Name: chat_participants_user_chat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chat_participants_user_chat_idx ON public.chat_participants USING btree (user_id, chat_id);


--
-- Name: chats_support_close_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX chats_support_close_idx ON public.chats USING btree (chat_type, support_close_requested_at, support_close_confirmed);


--
-- Name: disputes_close_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX disputes_close_idx ON public.disputes USING btree (trip_id, initiator_confirmed, respondent_confirmed, locked);


--
-- Name: idx_bank_cards_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bank_cards_user_id ON public.bank_cards USING btree (user_id);


--
-- Name: idx_cmr_chat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cmr_chat ON public.chat_message_reads USING btree (chat_id);


--
-- Name: idx_cmr_user_chat; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_cmr_user_chat ON public.chat_message_reads USING btree (user_id, chat_id);


--
-- Name: idx_company_reviews_organizer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_reviews_organizer_id ON public.company_reviews USING btree (organizer_id);


--
-- Name: idx_company_reviews_reviewer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_reviews_reviewer_id ON public.company_reviews USING btree (reviewer_id);


--
-- Name: idx_company_reviews_trip_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_company_reviews_trip_id ON public.company_reviews USING btree (trip_id);


--
-- Name: idx_message_chat_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_chat_id ON public.messages USING btree (chat_id);


--
-- Name: idx_message_sender_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_sender_id ON public.messages USING btree (sender_id);


--
-- Name: idx_payment_refunds_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_refunds_payment ON public.payment_refunds USING btree (payment_id);


--
-- Name: idx_payment_refunds_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_refunds_status ON public.payment_refunds USING btree (status, created_at DESC);


--
-- Name: idx_payment_refunds_status_payment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_refunds_status_payment ON public.payment_refunds USING btree (status, payment_id);


--
-- Name: idx_payment_refunds_trip_participant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_refunds_trip_participant ON public.payment_refunds USING btree (trip_id, participant_id);


--
-- Name: idx_payment_refunds_trip_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payment_refunds_trip_status ON public.payment_refunds USING btree (trip_id, status);


--
-- Name: idx_payments_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_order_id ON public.payments USING btree (order_id);


--
-- Name: idx_payments_status_flags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_status_flags ON public.payments USING btree (status, is_authorized, is_confirmed, is_refunded);


--
-- Name: idx_payments_trip_participant_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payments_trip_participant_created ON public.payments USING btree (trip_id, participant_id, created_at DESC);


--
-- Name: idx_payout_attempts_bank_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payout_attempts_bank_order_id ON public.payout_attempts USING btree (bank_order_id);


--
-- Name: idx_payout_attempts_external_order_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payout_attempts_external_order_id ON public.payout_attempts USING btree (external_order_id);


--
-- Name: idx_payout_attempts_trip_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payout_attempts_trip_status ON public.payout_attempts USING btree (trip_id, status, created_at DESC);


--
-- Name: idx_payout_logs_trip_time; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_payout_logs_trip_time ON public.payout_logs USING btree (trip_id, created_at DESC);


--
-- Name: idx_travel_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_travel_user_id ON public.travels USING btree (user_id);


--
-- Name: idx_user_cards_scope_primary; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_cards_scope_primary ON public.user_cards USING btree (user_id, card_scope, is_primary DESC, created_at DESC);


--
-- Name: mycompany_tbank_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX mycompany_tbank_code_idx ON public.mycompany USING btree (tbank_code);


--
-- Name: payment_refunds_trip_part_ext_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payment_refunds_trip_part_ext_idx ON public.payment_refunds USING btree (trip_id, participant_id, external_request_id);


--
-- Name: payout_attempts_source_payment_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX payout_attempts_source_payment_idx ON public.payout_attempts USING btree (source_payment_id);


--
-- Name: temp_otps_phone_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX temp_otps_phone_uq ON public.temp_otps USING btree (phone);


--
-- Name: temp_verifications_phone_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX temp_verifications_phone_uq ON public.temp_verifications USING btree (phone);


--
-- Name: trip_cancellations_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_cancellations_created_at_idx ON public.trip_cancellations USING btree (created_at DESC);


--
-- Name: trip_cancellations_trip_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_cancellations_trip_id_idx ON public.trip_cancellations USING btree (trip_id);


--
-- Name: trip_participants_trip_id_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_participants_trip_id_status_idx ON public.trip_participants USING btree (trip_id, status);


--
-- Name: trip_participants_trip_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_participants_trip_status_idx ON public.trip_participants USING btree (trip_id, status);


--
-- Name: trip_participants_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX trip_participants_user_idx ON public.trip_participants USING btree (user_id);


--
-- Name: uniq_user_cards_user_card_scope; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_user_cards_user_card_scope ON public.user_cards USING btree (user_id, card_id, card_scope);


--
-- Name: uq_payout_pending_per_source; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uq_payout_pending_per_source ON public.payout_attempts USING btree (source_payment_id) WHERE ((status)::text = 'pending'::text);


--
-- Name: user_cards_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_cards_user_id_idx ON public.user_cards USING btree (user_id);


--
-- Name: ux_payments_open_per_trip_participant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_payments_open_per_trip_participant ON public.payments USING btree (trip_id, participant_id) WHERE ((status = 'pending'::text) OR ((is_authorized IS TRUE) AND (is_confirmed IS FALSE)));


--
-- Name: ux_refunds_trip_extid_notnull; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_refunds_trip_extid_notnull ON public.payment_refunds USING btree (trip_id, external_request_id) WHERE (external_request_id IS NOT NULL);


--
-- Name: ux_refunds_trip_payment_extid_notnull; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_refunds_trip_payment_extid_notnull ON public.payment_refunds USING btree (trip_id, payment_id, external_request_id) WHERE (external_request_id IS NOT NULL);


--
-- Name: temp_verifications on_verification_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_verification_update AFTER UPDATE OF verified ON public.temp_verifications FOR EACH ROW EXECUTE FUNCTION public.verify_user_email();


--
-- Name: chat_messages send_push_notification; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER send_push_notification AFTER INSERT ON public.chat_messages FOR EACH ROW EXECUTE FUNCTION public.send_push_notification();


--
-- Name: chat_message_reads trg_chat_message_reads_fill_chat_id; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_chat_message_reads_fill_chat_id BEFORE INSERT ON public.chat_message_reads FOR EACH ROW EXECUTE FUNCTION public.chat_message_reads_fill_chat_id();


--
-- Name: payment_refunds trg_payment_refunds_after_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payment_refunds_after_change AFTER INSERT OR UPDATE ON public.payment_refunds FOR EACH ROW EXECUTE FUNCTION public.trg_payment_refunds_after_change();


--
-- Name: payment_refunds trg_payment_refunds_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payment_refunds_set_updated_at BEFORE UPDATE ON public.payment_refunds FOR EACH ROW EXECUTE FUNCTION public.trg_payment_refunds_set_updated_at();


--
-- Name: payments trg_payments_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_payments_set_updated_at BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: user_admin_access trg_user_admin_access_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_user_admin_access_set_updated_at BEFORE UPDATE ON public.user_admin_access FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: temp_otps trigger_confirm_email_after_otp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_confirm_email_after_otp AFTER DELETE ON public.temp_otps FOR EACH ROW EXECUTE FUNCTION public.confirm_email_after_otp_verification();


--
-- Name: temp_verifications trigger_verify_user_email; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_verify_user_email AFTER UPDATE ON public.temp_verifications FOR EACH ROW WHEN (((old.verified IS DISTINCT FROM new.verified) AND (new.verified = true) AND (new.is_registration = true))) EXECUTE FUNCTION public.verify_user_email();


--
-- Name: bank_cards update_bank_cards_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_bank_cards_updated_at BEFORE UPDATE ON public.bank_cards FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();


--
-- Name: trip_cancellations update_trip_cancellations_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_trip_cancellations_updated_at BEFORE UPDATE ON public.trip_cancellations FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: bank_cards bank_cards_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bank_cards
    ADD CONSTRAINT bank_cards_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: chat_message_files chat_message_files_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_message_files
    ADD CONSTRAINT chat_message_files_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.chat_messages(id) ON DELETE CASCADE;


--
-- Name: chat_message_reads chat_message_reads_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_message_reads
    ADD CONSTRAINT chat_message_reads_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.chat_messages(id) ON DELETE CASCADE;


--
-- Name: chat_message_reads chat_message_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_message_reads
    ADD CONSTRAINT chat_message_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_chat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.chats(id) ON DELETE CASCADE;


--
-- Name: chat_messages chat_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_messages
    ADD CONSTRAINT chat_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: chat_participants chat_participants_chat_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_participants
    ADD CONSTRAINT chat_participants_chat_id_fkey FOREIGN KEY (chat_id) REFERENCES public.chats(id) ON DELETE CASCADE;


--
-- Name: chat_participants chat_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chat_participants
    ADD CONSTRAINT chat_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: chats chats_moderator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chats
    ADD CONSTRAINT chats_moderator_id_fkey FOREIGN KEY (moderator_id) REFERENCES public.profiles(user_id);


--
-- Name: chats chats_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chats
    ADD CONSTRAINT chats_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: chats chats_user_id_1_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chats
    ADD CONSTRAINT chats_user_id_1_fkey FOREIGN KEY (user_id_1) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: chats chats_user_id_2_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.chats
    ADD CONSTRAINT chats_user_id_2_fkey FOREIGN KEY (user_id_2) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: company_reviews company_reviews_organizer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_reviews
    ADD CONSTRAINT company_reviews_organizer_id_fkey FOREIGN KEY (organizer_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: company_reviews company_reviews_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_reviews
    ADD CONSTRAINT company_reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: company_reviews company_reviews_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_reviews
    ADD CONSTRAINT company_reviews_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: dispute_close_proposals dispute_close_proposals_initiator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispute_close_proposals
    ADD CONSTRAINT dispute_close_proposals_initiator_id_fkey FOREIGN KEY (initiator_id) REFERENCES public.profiles(user_id);


--
-- Name: dispute_close_proposals dispute_close_proposals_moderator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispute_close_proposals
    ADD CONSTRAINT dispute_close_proposals_moderator_id_fkey FOREIGN KEY (moderator_id) REFERENCES public.profiles(user_id);


--
-- Name: dispute_close_proposals dispute_close_proposals_organizer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispute_close_proposals
    ADD CONSTRAINT dispute_close_proposals_organizer_id_fkey FOREIGN KEY (organizer_id) REFERENCES public.profiles(user_id);


--
-- Name: dispute_close_proposals dispute_close_proposals_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispute_close_proposals
    ADD CONSTRAINT dispute_close_proposals_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: dispute_evidences dispute_evidences_dispute_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispute_evidences
    ADD CONSTRAINT dispute_evidences_dispute_id_fkey FOREIGN KEY (dispute_id) REFERENCES public.disputes(id);


--
-- Name: dispute_evidences dispute_evidences_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.dispute_evidences
    ADD CONSTRAINT dispute_evidences_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.profiles(user_id);


--
-- Name: disputes disputes_initiator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_initiator_id_fkey FOREIGN KEY (initiator_id) REFERENCES public.profiles(user_id);


--
-- Name: disputes disputes_respondent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_respondent_id_fkey FOREIGN KEY (respondent_id) REFERENCES public.profiles(user_id);


--
-- Name: disputes disputes_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.disputes
    ADD CONSTRAINT disputes_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id);


--
-- Name: messages messages_sender_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_sender_id_fkey FOREIGN KEY (sender_id) REFERENCES public.users(id);


--
-- Name: mycompany mycompany_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mycompany
    ADD CONSTRAINT mycompany_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: payment_refunds payment_refunds_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(user_id);


--
-- Name: payment_refunds payment_refunds_participant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: payment_refunds payment_refunds_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_payment_id_fkey FOREIGN KEY (payment_id) REFERENCES public.payments(id) ON DELETE CASCADE;


--
-- Name: payment_refunds payment_refunds_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payment_refunds
    ADD CONSTRAINT payment_refunds_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: payments payments_participant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES public.profiles(user_id);


--
-- Name: payments payments_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payments
    ADD CONSTRAINT payments_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id);


--
-- Name: payout_attempts payout_attempts_participant_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_attempts
    ADD CONSTRAINT payout_attempts_participant_id_fkey FOREIGN KEY (participant_id) REFERENCES public.trip_participants(id);


--
-- Name: payout_attempts payout_attempts_source_payment_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_attempts
    ADD CONSTRAINT payout_attempts_source_payment_id_fkey FOREIGN KEY (source_payment_id) REFERENCES public.payments(id) ON DELETE SET NULL;


--
-- Name: payout_attempts payout_attempts_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_attempts
    ADD CONSTRAINT payout_attempts_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id);


--
-- Name: payout_logs payout_logs_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.payout_logs
    ADD CONSTRAINT payout_logs_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id);


--
-- Name: push_subscriptions push_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: realtime_subscriptions realtime_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.realtime_subscriptions
    ADD CONSTRAINT realtime_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: reviews reviews_organizer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_organizer_id_fkey FOREIGN KEY (organizer_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: reviews reviews_reviewer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_reviewer_id_fkey FOREIGN KEY (reviewer_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: reviews reviews_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reviews
    ADD CONSTRAINT reviews_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: travels travels_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.travels
    ADD CONSTRAINT travels_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: trip_cancellations trip_cancellations_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_cancellations
    ADD CONSTRAINT trip_cancellations_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id);


--
-- Name: trip_participants trip_participants_trip_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_participants
    ADD CONSTRAINT trip_participants_trip_id_fkey FOREIGN KEY (trip_id) REFERENCES public.trips(id) ON DELETE CASCADE;


--
-- Name: trip_participants trip_participants_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trip_participants
    ADD CONSTRAINT trip_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: trips trips_creator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trips
    ADD CONSTRAINT trips_creator_id_fkey FOREIGN KEY (creator_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: user_admin_access user_admin_access_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_admin_access
    ADD CONSTRAINT user_admin_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id) ON DELETE CASCADE;


--
-- Name: user_cards user_cards_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_cards
    ADD CONSTRAINT user_cards_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(user_id);


--
-- Name: profiles Allow all to read profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all to read profiles" ON public.profiles FOR SELECT TO authenticated, anon USING (true);


--
-- Name: profiles Enable insert for authenticated users only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable insert for authenticated users only" ON public.profiles FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: trips Enable insert for authenticated users only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable insert for authenticated users only" ON public.trips FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: profiles Users can access their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can access their own profile" ON public.profiles FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: bank_cards Users can delete own cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own cards" ON public.bank_cards FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: bank_cards Users can insert own cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own cards" ON public.bank_cards FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: bank_cards Users can update own cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own cards" ON public.bank_cards FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: profiles Users can update their own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own profile" ON public.profiles FOR UPDATE TO authenticated USING ((auth.uid() = user_id));


--
-- Name: bank_cards Users can view own cards; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own cards" ON public.bank_cards FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: profiles all_authenticated_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY all_authenticated_access ON public.profiles FOR SELECT TO authenticated USING (true);


--
-- Name: bank_cards; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bank_cards ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_message_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.chat_message_files ENABLE ROW LEVEL SECURITY;

--
-- Name: chat_message_files cmf_insert_participants_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cmf_insert_participants_or_admin ON public.chat_message_files FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM ((public.chat_messages m
     JOIN public.chats c ON ((c.id = m.chat_id)))
     JOIN public.chat_participants p ON ((p.chat_id = c.id)))
  WHERE ((m.id = chat_message_files.message_id) AND ((p.user_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM public.user_admin_access uaa
          WHERE ((uaa.user_id = auth.uid()) AND ((uaa.is_admin = true) OR (uaa.chats = true))))))))));


--
-- Name: chat_message_files cmf_select_participants_or_admin; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY cmf_select_participants_or_admin ON public.chat_message_files FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM ((public.chat_messages m
     JOIN public.chats c ON ((c.id = m.chat_id)))
     JOIN public.chat_participants p ON ((p.chat_id = c.id)))
  WHERE ((m.id = chat_message_files.message_id) AND ((p.user_id = auth.uid()) OR (EXISTS ( SELECT 1
           FROM public.user_admin_access uaa
          WHERE ((uaa.user_id = auth.uid()) AND ((uaa.is_admin = true) OR (uaa.chats = true))))))))));


--
-- Name: dispute_close_proposals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.dispute_close_proposals ENABLE ROW LEVEL SECURITY;

--
-- Name: dispute_close_proposals insert only moderator; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "insert only moderator" ON public.dispute_close_proposals FOR INSERT WITH CHECK ((auth.uid() = moderator_id));


--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: user_admin_access read_own_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY read_own_access ON public.user_admin_access FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: dispute_close_proposals select own dispute close proposals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "select own dispute close proposals" ON public.dispute_close_proposals FOR SELECT USING (((auth.uid() = initiator_id) OR (auth.uid() = organizer_id) OR (auth.uid() = moderator_id)));


--
-- Name: trip_cancellations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trip_cancellations ENABLE ROW LEVEL SECURITY;

--
-- Name: trip_cancellations trip_cancellations_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trip_cancellations_insert ON public.trip_cancellations FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.trips
  WHERE ((trips.id = trip_cancellations.trip_id) AND (trips.creator_id = auth.uid())))));


--
-- Name: trip_cancellations trip_cancellations_insert_by_creator; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trip_cancellations_insert_by_creator ON public.trip_cancellations FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.trips t
  WHERE ((t.id = trip_cancellations.trip_id) AND (t.creator_id = auth.uid())))));


--
-- Name: trip_cancellations trip_cancellations_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trip_cancellations_select ON public.trip_cancellations FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.trips
  WHERE ((trips.id = trip_cancellations.trip_id) AND (trips.creator_id = auth.uid())))));


--
-- Name: trip_cancellations trip_cancellations_select_by_creator; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trip_cancellations_select_by_creator ON public.trip_cancellations FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.trips t
  WHERE ((t.id = trip_cancellations.trip_id) AND (t.creator_id = auth.uid())))));


--
-- Name: trip_cancellations trip_cancellations_update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trip_cancellations_update ON public.trip_cancellations FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.trips
  WHERE ((trips.id = trip_cancellations.trip_id) AND (trips.creator_id = auth.uid())))));


--
-- Name: trip_cancellations trip_cancellations_update_by_creator; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trip_cancellations_update_by_creator ON public.trip_cancellations FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.trips t
  WHERE ((t.id = trip_cancellations.trip_id) AND (t.creator_id = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.trips t
  WHERE ((t.id = trip_cancellations.trip_id) AND (t.creator_id = auth.uid())))));


--
-- Name: trips trips_select_by_creator; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY trips_select_by_creator ON public.trips FOR SELECT TO authenticated USING ((creator_id = auth.uid()));


--
-- Name: dispute_close_proposals update own dispute close proposals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "update own dispute close proposals" ON public.dispute_close_proposals FOR UPDATE USING (((auth.uid() = initiator_id) OR (auth.uid() = organizer_id) OR (auth.uid() = moderator_id)));


--
-- Name: user_admin_access; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_admin_access ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

