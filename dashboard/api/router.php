<?php
declare(strict_types=1);
$route = $_GET['route'] ?? '';
if (!is_string($route)) json_response(['error'=>'invalid_route'], 400);
if ($route === '') {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') json_response(['error'=>'method_not_allowed'], 405);
    $html = (string)file_get_contents(__DIR__ . '/../view.html');
    header('Content-Type: text/html; charset=utf-8');
    echo str_replace(['{{CSRF_TOKEN}}','{{VERSION}}'], [htmlspecialchars((string)$_SESSION['csrf'], ENT_QUOTES, 'UTF-8'),htmlspecialchars(synk_version(), ENT_QUOTES, 'UTF-8')], $html);
    exit;
}
$pdo = null;
try {
    // Legacy JSON/browser stores must never acknowledge a booking mutation.
    if (in_array($route, ['save_booking','update_booking','delete_booking','bookings_save','booking_create','booking_update','booking_delete'], true)) {
        json_response(['error'=>'legacy_booking_write_disabled_use_gestione_appuntamenti'],410);
    }
    $reads = ['db_catalog','db_appointments','db_clients','db_datetime'];
    $allowed = ['db_clients','db_client_create','db_catalog','db_appointments','db_datetime','db_service_save','db_professional_save','db_professional_services_save','db_appointment_save','db_appointment_cancel','db_appointment_delete'];
    if (!in_array($route, $allowed, true)) throw new SynkHttpError(404, 'route_not_found');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $isRead = in_array($route, $reads, true);
    if ($method !== ($isRead ? 'GET' : 'POST')) throw new SynkHttpError(405, 'method_not_allowed');
    $body = $isRead ? [] : synk_body();
    if ($route === 'db_datetime') {
        $start = synk_parse_appointment_datetime(synk_text($_GET['start'] ?? null, 'start_time', 40));
        $end = synk_parse_appointment_datetime(synk_text($_GET['end'] ?? null, 'end_time', 40));
        if ($end <= $start) throw new SynkHttpError(422, 'invalid_date_range');
        json_response(['start'=>$start->format(DateTimeInterface::ATOM),'end'=>$end->format(DateTimeInterface::ATOM)]);
    }
    $pdo = synk_db();
    if ($route === 'db_catalog') json_response(synk_catalog($pdo));
    if ($route === 'db_appointments') json_response(synk_appointments($pdo, $_GET));
    if ($route === 'db_clients') {
        $q = $_GET['q'] ?? '';
        if (!is_string($q) || strlen($q) > 80) throw new SynkHttpError(422, 'invalid_search');
        json_response(['clients'=>synk_query($pdo, 'SELECT client_id,full_name FROM public.clients WHERE full_name ILIKE ? ORDER BY full_name,client_id LIMIT 100', ['%' . $q . '%'])->fetchAll()]);
    }
    if ($route === 'db_client_create') {
        $name = synk_text($body['name'] ?? null, 'client_name');
        $phone = $body['phone'] ?? '';
        if (!is_string($phone) || ($phone !== '' && !preg_match('/^\+?[0-9]{5,20}$/D', $phone))) throw new SynkHttpError(422, 'invalid_phone');
        $phone = ltrim($phone, '+');
        $pdo->beginTransaction();
        $id = (int)synk_query($pdo, 'INSERT INTO public.clients(full_name) VALUES(?) RETURNING client_id', [$name])->fetchColumn();
        if ($phone !== '') {
            synk_query($pdo, "INSERT INTO public.client_contacts(client_id,type,value) VALUES(?,'phone',?),(?,'whatsapp_chat',?)", [$id,$phone,$id,$phone . '@c.us']);
        }
        $pdo->commit(); json_response(['id'=>$id], 201);
    }
    if ($route === 'db_service_save') json_response(synk_save_service($pdo, $body));
    if ($route === 'db_professional_save') json_response(synk_save_professional($pdo, $body));
    if ($route === 'db_professional_services_save') json_response(synk_save_assignments($pdo, $body));

    if ($route === 'db_appointment_save') {
        assert_calendar_not_suspended();
        $id = isset($body['id']) ? synk_int($body['id'], 'appointment_id') : null;
        $proId = synk_int($body['professionalId'] ?? null, 'professional_id');
        $clientId = synk_int($body['clientId'] ?? null, 'client_id');
        $rawServices = $body['serviceIds'] ?? null;
        if (!is_array($rawServices) || !array_is_list($rawServices) || count($rawServices) < 1 || count($rawServices) > 6) throw new SynkHttpError(422, 'select_one_to_six_services');
        foreach ($rawServices as $value) synk_int($value, 'service_id');
        $serviceIds = array_map('intval', $rawServices);
        if (count(array_unique($serviceIds)) !== count($serviceIds)) throw new SynkHttpError(422, 'duplicate_service');
        $startTime = synk_text($body['startTime'] ?? null, 'start_time', 40);
        $startAt = synk_parse_appointment_datetime($startTime);
        $startTime = $startAt->format(DateTimeInterface::ATOM);
        if ($startAt->getTimestamp() < time() - 300) throw new SynkHttpError(422, 'appointment_must_be_future');
        $pdo->beginTransaction();
        // Serialize dashboard writers per professional. PostgreSQL's exclusion
        // constraint also protects against bot/concurrent external DB writers.
        synk_query($pdo, 'SELECT pg_advisory_xact_lock(?)', [$proId]);
        $old = $id === null ? null : synk_existing_appointment($pdo, $id, $body['updatedAt'] ?? null);
        if ($old && !in_array($old['status'], ['pending','confirmed'], true)) throw new SynkHttpError(409, 'only_active_appointments_can_be_edited');
        if ($old) synk_assert_no_calendar_jobs($pdo, $old);
        if (!synk_query($pdo, 'SELECT 1 FROM public.clients WHERE client_id=?', [$clientId])->fetchColumn()) throw new SynkHttpError(404, 'client_not_found');
        $professional = synk_query($pdo, 'SELECT pe.email FROM public.professionals p JOIN public.professional_emails pe USING(professional_id) WHERE p.professional_id=? AND p.is_active=true ORDER BY pe.email LIMIT 1 FOR SHARE OF p', [$proId])->fetch();
        if (!$professional) throw new SynkHttpError(422, 'professional_not_active_or_calendar_missing');
        $totalMinutes = 0; $durations = [];
        foreach ($serviceIds as $serviceId) {
            $service = synk_query($pdo, 'SELECT COALESCE(d.duration_min,s.default_duration_min) AS minutes,s.buffer_after_min FROM public.services s JOIN public.professional_services ps USING(service_id) LEFT JOIN public.professional_service_durations d USING(professional_id,service_id) WHERE s.service_id=? AND ps.professional_id=? AND s.is_active=true FOR SHARE OF s,ps', [$serviceId,$proId])->fetch();
            if (!$service) throw new SynkHttpError(422, 'trattamento_non_abilitato_per_operatrice');
            $minutes = (int)$service['minutes']; $buffer = (int)$service['buffer_after_min'];
            $totalMinutes += $minutes + $buffer;
            $durations[$serviceId] = $minutes + $buffer;
        }
        if ($totalMinutes < 1 || $totalMinutes > 960) throw new SynkHttpError(422, 'invalid_total_duration');
        $endAt = (new DateTimeImmutable('@' . ($startAt->getTimestamp() + $totalMinutes * 60)))->setTimezone(synk_timezone());
        $endTime = $endAt->format(DateTimeInterface::ATOM);
        synk_assert_open($pdo, $proId, $startAt, $endAt);
        assert_external_calendar_available($proId, $startTime, $endTime, $id);
        if ($old) {
            synk_query($pdo, 'UPDATE public.appointments SET client_id=?,professional_id=?,service_id=?,start_time=?,end_time=?,updated_at=now() WHERE appointment_id=?', [$clientId,$proId,$serviceIds[0],$startTime,$endTime,$id]);
            synk_query($pdo, 'DELETE FROM public.appointment_services WHERE appointment_id=?', [$id]);
        } else {
            $id = (int)synk_query($pdo, "INSERT INTO public.appointments(client_id,professional_id,service_id,start_time,end_time,status) VALUES(?,?,?,?,?,'confirmed') RETURNING appointment_id", [$clientId,$proId,$serviceIds[0],$startTime,$endTime])->fetchColumn();
        }
        foreach ($serviceIds as $order=>$serviceId) {
            synk_query($pdo, 'INSERT INTO public.appointment_services(appointment_id,service_id,duration_min,sort_order) VALUES(?,?,?,?)', [$id,$serviceId,$durations[$serviceId],$order]);
        }
        $replaceEvent = !$old || (int)$old['professional_id'] !== $proId || (int)$old['client_id'] !== $clientId;
        if ($replaceEvent) {
            if ($old) enqueue_calendar_job($pdo, 'cancel', $old['event_id'], $old['calendar_id']);
            $eventId = bin2hex(random_bytes(16)); $calendarId = $professional['email'];
            synk_query($pdo, "INSERT INTO public.appointment_calendar(appointment_id,provider,event_id,calendar_id) VALUES(?,'gcal',?,?) ON CONFLICT(appointment_id) DO UPDATE SET event_id=EXCLUDED.event_id,calendar_id=EXCLUDED.calendar_id", [$id,$eventId,$calendarId]);
            enqueue_calendar_job($pdo, 'create', $eventId, $calendarId, ['appointmentId'=>$id]);
        } else {
            enqueue_calendar_job($pdo, 'reschedule', $old['event_id'], $old['calendar_id'], ['start'=>$startTime,'end'=>$endTime]);
            enqueue_calendar_job($pdo, 'update', $old['event_id'], $old['calendar_id'], ['appointmentId'=>$id]);
        }
        assert_calendar_not_suspended();
        $pdo->commit(); json_response(['id'=>$id,'calendarStatus'=>'pending'], $old ? 200 : 201);
    }

    if ($route === 'db_appointment_cancel') {
        assert_calendar_not_suspended();
        $id = synk_int($body['id'] ?? null, 'appointment_id');
        $status = $body['status'] ?? 'cancelled';
        if (!in_array($status, ['pending','confirmed','cancelled','completed','no_show'], true)) throw new SynkHttpError(422, 'invalid_status');
        $pdo->beginTransaction();
        $old = synk_existing_appointment($pdo, $id, $body['updatedAt'] ?? null);
        synk_query($pdo, 'SELECT pg_advisory_xact_lock(?)', [(int)$old['professional_id']]);
        if (in_array($old['status'], ['cancelled','canceled','annullato'], true)) {
            // Cannot reactivate a cancelled appointment: new booking, new Calendar check.
            if ($status !== 'cancelled') throw new SynkHttpError(409, 'Cannot reactivate a cancelled appointment');
            $pdo->commit(); json_response(['ok'=>true]);
        }
        synk_assert_no_calendar_jobs($pdo, $old);
        if (in_array($status, ['pending','confirmed'], true)) {
            if (!in_array($old['status'], ['pending','confirmed'], true)) throw new SynkHttpError(409, 'create_a_new_appointment');
            assert_external_calendar_available((int)$old['professional_id'], $old['start_time'], $old['end_time'], $id);
        }
        if (in_array($status, ['completed','no_show'], true) && strtotime($old['end_time']) > time()) throw new SynkHttpError(422, 'cannot_complete_future_appointment');
        synk_query($pdo, 'UPDATE public.appointments SET status=?,updated_at=now() WHERE appointment_id=?', [$status,$id]);
        if ($status === 'cancelled') {
            $payload = ['start'=>$old['start_time'],'end'=>$old['end_time'],'professionalId'=>(int)$old['professional_id'],'serviceId'=>(int)$old['service_id']];
            enqueue_calendar_job($pdo, 'cancel', $old['event_id'], $old['calendar_id'], $payload);
        }
        assert_calendar_not_suspended();
        $pdo->commit(); json_response(['ok'=>true,'calendarStatus'=>$status === 'cancelled' ? 'pending' : 'synced']);
    }
    if ($route === 'db_appointment_delete') {
        throw new SynkHttpError(410, 'delete_disabled_cancel_appointment_instead');
    }
    throw new SynkHttpError(404, 'route_not_found');
} catch (Throwable $error) {
    if ($pdo instanceof PDO && $pdo->inTransaction()) $pdo->rollBack();
    if ($error instanceof SynkHttpError) json_response(['error'=>$error->getMessage()], $error->status);
    if ($error instanceof InvalidArgumentException) json_response(['error'=>$error->getMessage()], 422);
    if ($error instanceof PDOException && in_array((string)$error->getCode(), ['23P01','23505','40001','40P01','55P03'], true)) json_response(['error'=>'conflict_reload_before_retry'], 409);
    // Never log SQL, customer data, tokens or provider responses.
    error_log('synk_dashboard_request_failed:' . get_class($error));
    json_response(['error'=>'operation_unavailable'], 503);
}
