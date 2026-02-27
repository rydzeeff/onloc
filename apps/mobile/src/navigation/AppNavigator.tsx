import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import AuthScreen from '../screens/AuthScreen';
import TripsScreen from '../screens/TripsScreen';
import TripDetailsScreen from '../screens/TripDetailsScreen';
import MessagesScreen from '../screens/MessagesScreen';
import ProfileScreen from '../screens/ProfileScreen';
import { useAuth } from '../providers/AuthProvider';
import { env } from '../lib/env';
import DashboardScreen from '../screens/DashboardScreen';
import DiagnosticsScreen from '../screens/DiagnosticsScreen';
import TripParticipantsScreen from '../screens/TripParticipantsScreen';

const Stack = createNativeStackNavigator();
const Tab = createBottomTabNavigator();

function TripsStack() {
  return (
    <Stack.Navigator>
      <Stack.Screen name='TripsList' component={TripsScreen} options={{ title: 'Поездки' }} />
      <Stack.Screen name='TripDetails' component={TripDetailsScreen} options={{ title: 'Детали поездки' }} />
      <Stack.Screen name='TripParticipants' component={TripParticipantsScreen} options={{ title: 'Участники' }} />
    </Stack.Navigator>
  );
}

function Tabs() {
  return (
    <Tab.Navigator initialRouteName="Trips">
      <Tab.Screen name='Dashboard' component={DashboardScreen} options={{ title: 'Дашборд' }} />
      <Tab.Screen name='Trips' component={TripsStack} options={{ headerShown: false, title: 'Поездки' }} />
      <Tab.Screen name='Messages' component={MessagesScreen} options={{ title: 'Сообщения' }} />
      <Tab.Screen name='Profile' component={ProfileScreen} options={{ title: 'Настройки' }} />
      {__DEV__ ? <Tab.Screen name='Diagnostics' component={DiagnosticsScreen} /> : null}
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  const { session, loading } = useAuth();
  if (loading) return null;

  return (
    <NavigationContainer
      linking={{
        prefixes: [`${env.scheme}://`],
        config: { screens: { Dashboard: 'dashboard', Trips: 'trips', Messages: 'messages', Profile: 'profile' } },
      }}
    >
      {session ? <Tabs /> : <AuthScreen />}
    </NavigationContainer>
  );
}
