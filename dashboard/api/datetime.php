<?php
declare(strict_types=1);

function synk_timezone(): DateTimeZone {
    return new DateTimeZone((string)(getenv('TZ') ?: 'Europe/Rome'));
}

/** Strict ISO input. A datetime-local value must identify exactly one instant. */
function synk_parse_appointment_datetime(string $input): DateTimeImmutable {
    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/D', $input, $m)) {
        throw new InvalidArgumentException('invalid_appointment_datetime');
    }
    if (!checkdate((int)$m[2], (int)$m[3], (int)$m[1]) || (int)$m[4] > 23 || (int)$m[5] > 59 || (int)($m[6] ?? 0) > 59) {
        throw new InvalidArgumentException('invalid_appointment_datetime');
    }
    $wall = substr($input, 0, 16) . ':' . (($m[6] ?? '') !== '' ? $m[6] : '00');
    $offset = $m[7] ?? '';
    if ($offset !== '') {
        if ($offset === 'Z') $offset = '+00:00';
        $hours = (int)substr($offset, 1, 2);
        $minutes = (int)substr($offset, 4, 2);
        if ($hours > 14 || $minutes > 59 || ($hours === 14 && $minutes !== 0)) {
            throw new InvalidArgumentException('invalid_timezone_offset');
        }
        $date = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:sP', $wall . $offset);
        if ($date === false) throw new InvalidArgumentException('invalid_appointment_datetime');
        return $date->setTimezone(synk_timezone());
    }
    $utc = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s', $wall, new DateTimeZone('UTC'));
    if ($utc === false) throw new InvalidArgumentException('invalid_appointment_datetime');
    $zone = synk_timezone();
    $base = $utc->getTimestamp();
    $transitions = $zone->getTransitions($base - 172800, $base + 172800);
    $offsets = $transitions === false ? [$zone->getOffset($utc)] : array_column($transitions, 'offset');
    $matches = [];
    foreach (array_unique($offsets) as $seconds) {
        $candidate = (new DateTimeImmutable('@' . ($base - $seconds)))->setTimezone($zone);
        if ($candidate->format('Y-m-d\TH:i:s') === $wall) $matches[$candidate->getTimestamp()] = $candidate;
    }
    if (count($matches) !== 1) throw new InvalidArgumentException('ambiguous_or_nonexistent_local_time');
    return array_values($matches)[0];
}
