import type { Metadata } from 'next';
import { Blank, ListPage, Loading, OnPhone, Sub, Td } from '@/system';
import { InboxView, PhoneCompose } from '@/views/inbox.tsx';

export const metadata: Metadata = { title: 'Inbox' };

export default function Inbox() {
  return (
    <ListPage title="Inbox" actions={<PhoneCompose />}>
      <InboxView
        loading={
          <Loading>
            <Td phone="hide" className="w-px">
              <Blank className="size-3.5" />
            </Td>
            <Td className="max-w-0 md:w-[22%] md:min-w-48">
              <Blank />
              <OnPhone>
                <span className="w-full text-base">
                  <Blank />
                </span>
                <Blank />
              </OnPhone>
            </Td>
            <Td phone="hide" className="max-w-0 md:w-full">
              <Blank />
              <Sub>
                <Blank />
              </Sub>
            </Td>
            <Td phone="hide">
              <Blank word />
            </Td>
            <Td phone="hide" num>
              <Blank word />
            </Td>
          </Loading>
        }
      />
    </ListPage>
  );
}
