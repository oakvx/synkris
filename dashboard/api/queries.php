<?php
declare(strict_types=1);

function synk_catalog(PDO $pdo): array {
    return [
        'services'=>synk_query($pdo, 'SELECT service_id,service_name,default_duration_min,buffer_after_min,base_price,is_active FROM public.services ORDER BY display_order,service_name')->fetchAll(),
        'professionals'=>synk_query($pdo, "SELECT p.professional_id,p.full_name,COALESCE(p.email,(SELECT pe.email FROM public.professional_emails pe WHERE pe.professional_id=p.professional_id ORDER BY pe.email LIMIT 1)) AS email,p.is_active FROM public.professionals p ORDER BY p.full_name")->fetchAll(),
        'assignments'=>synk_query($pdo, 'SELECT ps.professional_id,ps.service_id,COALESCE(d.duration_min,s.default_duration_min) AS duration_min FROM public.professional_services ps JOIN public.services s USING(service_id) LEFT JOIN public.professional_service_durations d USING(professional_id,service_id) ORDER BY ps.professional_id,ps.service_id')->fetchAll(),
    ];
}

function synk_appointments(PDO $pdo, array $input): array {
    $limit = synk_int($input['limit'] ?? 100, 'limit', 1, 200);
    $mode = $input['mode'] ?? 'future';
    if (!in_array($mode, ['future','past','all'], true)) throw new SynkHttpError(422, 'invalid_filter');
    $where = $mode === 'future' ? 'a.end_time >= now()' : ($mode === 'past' ? 'a.end_time < now()' : 'TRUE');
    $params = [];
    foreach (['from','to'] as $key) {
        if (!isset($input[$key]) || $input[$key] === '') continue;
        $date = (string)$input[$key];
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/D', $date)) throw new SynkHttpError(422, 'invalid_date_filter');
        $parsed = synk_parse_appointment_datetime($date . 'T00:00');
        $where .= $key === 'from' ? ' AND a.start_time >= ?' : ' AND a.start_time < ?';
        $params[] = ($key === 'from' ? $parsed : $parsed->modify('+1 day'))->format(DateTimeInterface::ATOM);
    }
    $order = $mode === 'past' ? 'DESC' : 'ASC';
    $sql = "SELECT a.*,c.full_name AS client_name,p.full_name AS professional_name,ac.event_id,ac.calendar_id,
        COALESCE((SELECT json_agg(aps.service_id ORDER BY aps.sort_order,aps.service_id) FROM public.appointment_services aps WHERE aps.appointment_id=a.appointment_id),'[]'::json) AS service_ids,
        COALESCE((SELECT string_agg(s.service_name,' + ' ORDER BY aps.sort_order,aps.service_id) FROM public.appointment_services aps JOIN public.services s USING(service_id) WHERE aps.appointment_id=a.appointment_id),'') AS service_names,
        CASE WHEN EXISTS(SELECT 1 FROM public.calendar_outbox o WHERE o.event_id=ac.event_id AND o.status='attention') THEN 'attention'
             WHEN EXISTS(SELECT 1 FROM public.calendar_outbox o WHERE o.event_id=ac.event_id AND o.status='pending') THEN 'pending'
             WHEN ac.calendar_id IS NULL THEN 'unbound' ELSE 'synced' END AS calendar_status
        FROM public.appointments a JOIN public.clients c USING(client_id)
        LEFT JOIN public.professionals p USING(professional_id)
        LEFT JOIN public.appointment_calendar ac USING(appointment_id)
        WHERE $where ORDER BY a.start_time $order,a.appointment_id $order LIMIT $limit";
    $rows = synk_query($pdo, $sql, $params)->fetchAll();
    foreach ($rows as &$row) $row['service_ids'] = json_decode($row['service_ids'], true, 16, JSON_THROW_ON_ERROR);
    return ['appointments'=>$rows, 'limit'=>$limit, 'maintenance'=>synk_calendar_suspended()];
}
