<?php
declare(strict_types=1);

function synk_lock_professional(PDO $pdo, int $id): void {
    synk_query($pdo, 'SELECT pg_advisory_xact_lock(?)', [$id]);
}
function synk_existing_appointment(PDO $pdo, int $id, mixed $updatedAt): array {
    $row = synk_query($pdo, 'SELECT a.*,ac.event_id,ac.calendar_id FROM public.appointments a LEFT JOIN public.appointment_calendar ac USING(appointment_id) WHERE a.appointment_id=? FOR UPDATE OF a', [$id])->fetch();
    if (!$row) throw new SynkHttpError(404, 'appointment_not_found');
    if (!is_string($updatedAt) || $updatedAt !== $row['updated_at']) throw new SynkHttpError(409, 'appointment_changed_reload');
    return $row;
}
function synk_assert_open(PDO $pdo, int $proId, DateTimeImmutable $start, DateTimeImmutable $end): void {
    $start = $start->setTimezone(synk_timezone()); $end = $end->setTimezone(synk_timezone());
    if ($start->format('Y-m-d') !== $end->format('Y-m-d')) throw new SynkHttpError(422, 'appointment_crosses_day');
    $day = $start->format('Y-m-d'); $weekday = (int)$start->format('N');
    $hours = synk_query($pdo, 'SELECT open_time,close_time,is_closed FROM public.salon_business_hours WHERE weekday=?', [$weekday])->fetch();
    if (!$hours || $hours['is_closed'] || $start->format('H:i:s') < $hours['open_time'] || $end->format('H:i:s') > $hours['close_time']) throw new SynkHttpError(422, 'outside_business_hours');
    if (synk_query($pdo, 'SELECT 1 FROM public.salon_closed_dates WHERE day=?::date', [$day])->fetchColumn()) throw new SynkHttpError(422, 'salon_closed');
    if (synk_query($pdo, 'SELECT 1 FROM public.salon_lunch_breaks WHERE weekday=? AND start_time<?::time AND end_time>?::time', [$weekday,$end->format('H:i:s'),$start->format('H:i:s')])->fetchColumn()) throw new SynkHttpError(422, 'lunch_break');
    if (synk_query($pdo, 'SELECT 1 FROM public.professional_unavailable_weekdays WHERE professional_id=? AND weekday=?', [$proId,$weekday])->fetchColumn() || synk_query($pdo, 'SELECT 1 FROM public.professional_time_off WHERE professional_id=? AND start_day<=?::date AND end_day>=?::date', [$proId,$day,$day])->fetchColumn()) throw new SynkHttpError(422, 'professional_unavailable');
}
function synk_boolean(mixed $value): string {
    if (!is_bool($value)) throw new SynkHttpError(422, 'invalid_active');
    return $value ? 'true' : 'false';
}
function synk_save_service(PDO $pdo, array $body): array {
    $id = isset($body['id']) ? synk_int($body['id'], 'service_id') : null;
    $name = synk_text($body['name'] ?? null, 'service_name');
    $duration = synk_int($body['durationMin'] ?? null, 'duration', 1, 960);
    $buffer = synk_int($body['bufferAfterMin'] ?? 0, 'buffer', 0, 180);
    $price = $body['price'] ?? null;
    if ($price === '') $price = null;
    if ($price !== null && (!is_scalar($price) || !preg_match('/^\d{1,7}(?:\.\d{1,2})?$/D', (string)$price))) throw new SynkHttpError(422, 'invalid_price');
    $active = synk_boolean($body['active'] ?? true);
    if ($id === null) $id = (int)synk_query($pdo, 'INSERT INTO public.services(service_name,default_duration_min,buffer_after_min,base_price,is_active) VALUES(?,?,?,?,?::boolean) RETURNING service_id', [$name,$duration,$buffer,$price,$active])->fetchColumn();
    elseif (!synk_query($pdo, 'UPDATE public.services SET service_name=?,default_duration_min=?,buffer_after_min=?,base_price=?,is_active=?::boolean,updated_at=now() WHERE service_id=? RETURNING service_id', [$name,$duration,$buffer,$price,$active,$id])->fetchColumn()) throw new SynkHttpError(404, 'service_not_found');
    return ['id'=>$id];
}
function synk_save_professional(PDO $pdo, array $body): array {
    $id = isset($body['id']) ? synk_int($body['id'], 'professional_id') : null;
    $name = synk_text($body['name'] ?? null, 'professional_name');
    $email = strtolower(synk_text($body['email'] ?? null, 'email', 254));
    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) throw new SynkHttpError(422, 'invalid_email');
    $active = synk_boolean($body['active'] ?? true);
    $pdo->beginTransaction();
    if ($id === null) $id = (int)synk_query($pdo, 'INSERT INTO public.professionals(full_name,email,is_active) VALUES(?,?,?::boolean) RETURNING professional_id', [$name,$email,$active])->fetchColumn();
    else {
        synk_lock_professional($pdo, $id);
        $existing = synk_query($pdo, 'SELECT email FROM public.professional_emails WHERE professional_id=? ORDER BY email', [$id])->fetchAll(PDO::FETCH_COLUMN);
        $busy = synk_query($pdo, "SELECT 1 FROM public.appointments WHERE professional_id=? AND end_time>now() AND status IN ('pending','confirmed') LIMIT 1", [$id])->fetchColumn();
        if ($busy && (!in_array($email, $existing, true) || $active === 'false')) throw new SynkHttpError(409, 'move_future_appointments_before_calendar_change');
        if (!synk_query($pdo, 'UPDATE public.professionals SET full_name=?,email=?,is_active=?::boolean,updated_at=now() WHERE professional_id=? RETURNING professional_id', [$name,$email,$active,$id])->fetchColumn()) throw new SynkHttpError(404, 'professional_not_found');
    }
    synk_query($pdo, 'DELETE FROM public.professional_emails WHERE professional_id=? AND email<>?', [$id,$email]);
    synk_query($pdo, 'INSERT INTO public.professional_emails(professional_id,email) VALUES(?,?) ON CONFLICT(professional_id,email) DO NOTHING', [$id,$email]);
    $pdo->commit();
    return ['id'=>$id];
}
function synk_save_assignments(PDO $pdo, array $body): array {
    $id = synk_int($body['professionalId'] ?? null, 'professional_id');
    $items = $body['services'] ?? null;
    if (!is_array($items) || !array_is_list($items) || count($items) > 500) throw new SynkHttpError(422, 'invalid_services');
    $pdo->beginTransaction(); synk_lock_professional($pdo, $id);
    if (!synk_query($pdo, 'SELECT 1 FROM public.professionals WHERE professional_id=? FOR UPDATE', [$id])->fetchColumn()) throw new SynkHttpError(404, 'professional_not_found');
    $seen = [];
    foreach ($items as $item) {
        $serviceId = synk_int($item['serviceId'] ?? null, 'service_id');
        $minutes = synk_int($item['durationMin'] ?? null, 'duration', 1, 960);
        if (isset($seen[$serviceId])) throw new SynkHttpError(422, 'duplicate_service');
        $seen[$serviceId] = $minutes;
    }
    synk_query($pdo, 'DELETE FROM public.professional_service_durations WHERE professional_id=?', [$id]);
    synk_query($pdo, 'DELETE FROM public.professional_services WHERE professional_id=?', [$id]);
    foreach ($seen as $serviceId=>$minutes) {
        synk_query($pdo, 'INSERT INTO public.professional_services(professional_id,service_id) VALUES(?,?)', [$id,$serviceId]);
        synk_query($pdo, 'INSERT INTO public.professional_service_durations(professional_id,service_id,duration_min) VALUES(?,?,?)', [$id,$serviceId,$minutes]);
    }
    $pdo->commit(); return ['ok'=>true];
}
