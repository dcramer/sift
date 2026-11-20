'use client';
import { Button, Dialog, Failure, Field, Form, TextArea } from '@/system';

/**
 * The first step of a dialog the model can fill in (a rule, labels): a question as the field's label, an
 * example in the box, and what follows from the answer as the hint, which says to wait while the model
 * works. The one press says what comes back; the other goes to the form by hand.
 */
export function DescribeStep({
  title,
  question,
  hint,
  placeholder,
  value,
  onChange,
  go,
  onGo,
  manual,
  onManual,
  busy,
  error,
  onClose,
}: {
  title: string;
  question: string;
  hint: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
  go: string;
  onGo: () => void;
  manual: string;
  onManual: () => void;
  busy: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const ready = value.trim() !== '';
  const submit = () => ready && onGo();
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ink" busy={busy} disabled={!ready} onClick={submit}>
            {go}
          </Button>
          <Button variant="quiet" onClick={onManual}>
            {manual}
          </Button>
          <Failure>{error}</Failure>
        </>
      }
    >
      <Form onSubmit={submit}>
        <Field label={question} hint={busy ? 'This can take a minute.' : hint}>
          <TextArea
            autoFocus
            aria-label={question}
            className="min-h-28 phone:min-h-48"
            maxLength={2000}
            placeholder={placeholder}
            value={value}
            // Words it was opened with end where the reader carries on.
            onFocus={(event) => event.currentTarget.setSelectionRange(value.length, value.length)}
            onChange={(event) => onChange(event.target.value)}
          />
        </Field>
      </Form>
    </Dialog>
  );
}
