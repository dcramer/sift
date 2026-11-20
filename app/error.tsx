'use client';
import { Failed } from '@/views/failed.tsx';

export default function Error({ error }: { error: unknown }) {
  return <Failed error={error} />;
}
