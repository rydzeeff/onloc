import { useRouter } from 'next/router';
import { useAuth } from './_app';
import TripParticipantsPagePC from './TripParticipantsPagePC';
import TripParticipantsPageMobile from './TripParticipantsPageMobile';

export default function Participants({ tripId }) {
  console.log('Рендеринг компонента Participants:', { tripId });
  const { isMobile } = useAuth();
  const router = useRouter();

  // fallback из URL (?tripId=...)
  const tripIdFromQuery = typeof router?.query?.tripId === 'string' ? router.query.tripId : undefined;
  const effectiveTripId = tripId || tripIdFromQuery;

  try {
    console.log('Выбор версии страницы:', { isMobile, effectiveTripId });
    return isMobile ? (
      <TripParticipantsPageMobile tripId={effectiveTripId} />
    ) : (
      <TripParticipantsPagePC tripId={effectiveTripId} />
    );
  } catch (error) {
    console.error('Ошибка при выборе версии страницы:', { error: error.message, tripId: effectiveTripId });
    return <div>Ошибка загрузки страницы</div>;
  }
}

export async function getServerSideProps(context) {
  try {
    // Поддержка как params (если когда-то будет /participants/[tripId]),
    // так и query (?tripId=...) — удобно при встраивании в /dashboard.
    const { params = {}, query = {} } = context;
    const tripIdFromParams = params.tripId;
    const tripIdFromQuery = typeof query.tripId === 'string' ? query.tripId : null;

    return { props: { tripId: tripIdFromParams ?? tripIdFromQuery ?? null } };
  } catch (error) {
    console.error('Ошибка в getServerSideProps:', { error: error.message, params: context.params, query: context.query });
    return { props: { tripId: null } };
  }
}
