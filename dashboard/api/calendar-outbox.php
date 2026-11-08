<?php
declare(strict_types=1);

function synk_calendar_suspended(): bool {
    $root = (string)env('APP_DATA_DIR', __DIR__ . '/../../runtime/config');
    return is_file(rtrim($root, '/\\') . '/calendar-reconciliation-required.flag');
}
function assert_calendar_not_suspended(): void {
    if (synk_calendar_suspended()) throw new SynkHttpError(503, 'calendar_reconciliation_required');
}
function assert_external_calendar_available(int $proId, string $startTime, string $endTime, ?int $appointmentId = null): void {
    assert_calendar_not_suspended();
    $token = (string)env('ADMIN_TOKEN', '');
    if (strlen($token) < 32 || !function_exists('curl_init')) throw new SynkHttpError(503, 'calendar_gate_unavailable');
    $ch = curl_init(rtrim((string)env('BOT_API_INTERNAL', 'http://bot:3000'), '/') . '/api/calendar/check-slot');
    curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER=>true, CURLOPT_CONNECTTIMEOUT=>3, CURLOPT_TIMEOUT=>15, CURLOPT_POST=>true, CURLOPT_FOLLOWLOCATION=>false, CURLOPT_PROTOCOLS=>CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_HTTPHEADER=>['X-Admin-Token: ' . $token, 'Content-Type: application/json'],
        CURLOPT_POSTFIELDS=>json_encode(['professionalId'=>$proId,'start'=>$startTime,'end'=>$endTime,'appointmentId'=>$appointmentId], JSON_THROW_ON_ERROR)]);
    $response = curl_exec($ch); $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE); curl_close($ch);
    if ($status === 409) throw new SynkHttpError(409, 'calendar_slot_occupied');
    $result = is_string($response) ? json_decode($response, true) : null;
    if ($status !== 200 || !is_array($result) || ($result['available'] ?? null) !== true) throw new SynkHttpError(503, 'calendar_unavailable');
}
function enqueue_calendar_job(PDO $pdo, string $operation, string $eventId, string $calendarId, array $payload = []): void {
    if (!in_array($operation, ['create','cancel','reschedule','update'], true) || $eventId === '' || $calendarId === '') throw new SynkHttpError(409, 'calendar_link_requires_review');
    synk_query($pdo, 'INSERT INTO public.calendar_outbox(operation,event_id,calendar_id,payload) VALUES(?,?,?,?::jsonb)', [$operation,$eventId,$calendarId,json_encode((object)$payload, JSON_THROW_ON_ERROR)]);
}
function synk_assert_no_calendar_jobs(PDO $pdo, array $appointment): void {
    if (empty($appointment['event_id']) || empty($appointment['calendar_id'])) throw new SynkHttpError(409, 'calendar_link_requires_review');
    $count = synk_query($pdo, "SELECT count(*) FROM public.calendar_outbox WHERE event_id=? AND status<>'done'", [$appointment['event_id']])->fetchColumn();
    if ((int)$count > 0) throw new SynkHttpError(409, 'calendar_sync_pending_or_attention');
}
