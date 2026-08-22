import { useState } from 'react';
import HomeScreen from './components/HomeScreen';
import MapTimelineScreen from './components/MapTimelineScreen';
import CelebrationScreen from './components/CelebrationScreen';
import SAMPLE_JEJU_PHOTOS from './data/samplePhotos';
import './App.css';

function App() {
  const [photos, setPhotos] = useState(null);
  const [pendingPhotos, setPendingPhotos] = useState(null);

  const handlePhotosParsed = (results) => {
    const normalized = results.map((photo, index) => ({
      id: `upload-${index}-${photo.fileName}`,
      ...photo,
    }));
    setPendingPhotos(normalized);
  };

  const handleSampleTrip = () => {
    setPendingPhotos(SAMPLE_JEJU_PHOTOS);
  };

  const handleCelebrationDone = () => {
    setPhotos(pendingPhotos);
    setPendingPhotos(null);
  };

  const handleBackToHome = () => {
    setPhotos(null);
    setPendingPhotos(null);
  };

  const handleOpenStoryModal = () => {
    // TODO: 화면 3 (인스타 스토리 카드) 모달 연결 예정
    window.alert('인스타 스토리 카드 만들기는 곧 만나보실 수 있어요!');
  };

  const handleUpdatePhotoLocation = (photoId, { latitude, longitude }) => {
    setPhotos((prev) =>
      prev.map((photo) =>
        photo.id === photoId ? { ...photo, latitude, longitude } : photo
      )
    );
  };

  if (pendingPhotos) {
    return <CelebrationScreen onDone={handleCelebrationDone} />;
  }

  if (photos) {
    return (
      <MapTimelineScreen
        photos={photos}
        onBack={handleBackToHome}
        onOpenStoryModal={handleOpenStoryModal}
        onGoHome={handleBackToHome}
        onUpdatePhotoLocation={handleUpdatePhotoLocation}
      />
    );
  }

  return (
    <HomeScreen
      onPhotosParsed={handlePhotosParsed}
      onSampleTrip={handleSampleTrip}
      onGoHome={handleBackToHome}
    />
  );
}

export default App;
