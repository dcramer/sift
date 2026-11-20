import type { Metadata } from 'next';
import { SenderCellLoading } from '@/components/sender.tsx';
import { Blank, ListPage, Loading, OnPhone, Td } from '@/system';
import { ContactsView } from '@/views/contacts.tsx';

export const metadata: Metadata = { title: 'Contacts' };

export default function Contacts() {
  return (
    <ListPage title="Contacts">
      <ContactsView
        loading={
          <Loading>
            <SenderCellLoading>
              <OnPhone>
                <span className="w-full">
                  <Blank />
                </span>
                <Blank />
              </OnPhone>
            </SenderCellLoading>
            <Td phone="hide" className="md:w-full">
              <Blank />
            </Td>
            <Td phone="hide">
              <Blank word />
            </Td>
            <Td phone="hide" num>
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
