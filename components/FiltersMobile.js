import { useState, useEffect, useRef } from 'react';
import DatePicker from 'react-datepicker';
import 'react-datepicker/dist/react-datepicker.css';
import styles from '../styles/filters.mobile.module.css';

export default function FiltersMobile({
  filters,
  setFilters,
  applyFilter,
  removeFilter,
  leisureTypeLabels,
  difficultyLabels,
  today,
  twoWeeksLater,
  setSelectedTripId,
  onMapClick,
onFilterOpen,
}) {
  const [activeFilter, setActiveFilter] = useState(null);
  const filtersRef = useRef(null);
  const priceDebounceRef = useRef(null);
  const datePickerRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (filtersRef.current && !filtersRef.current.contains(e.target)) {
        setActiveFilter(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (activeFilter === 'date' && datePickerRef.current) {
      let touchStartY = 0;
      let touchMoveY = 0;

      const handleTouchStart = (e) => {
        touchStartY = e.touches[0].clientY;
      };

      const handleTouchMove = (e) => {
        touchMoveY = e.touches[0].clientY;
        const diff = touchMoveY - touchStartY;
        if (diff > 0) {
          datePickerRef.current.style.transform = `translateY(${diff}px)`;
        }
      };

      const handleTouchEnd = () => {
        const diff = touchMoveY - touchStartY;
        if (diff > 100) {
          setActiveFilter(null);
        }
        datePickerRef.current.style.transform = 'translateY(0)';
      };

      const datePicker = datePickerRef.current;
      datePicker.addEventListener('touchstart', handleTouchStart);
      datePicker.addEventListener('touchmove', handleTouchMove);
      datePicker.addEventListener('touchend', handleTouchEnd);

      return () => {
        datePicker.removeEventListener('touchstart', handleTouchStart);
        datePicker.removeEventListener('touchmove', handleTouchMove);
        datePicker.removeEventListener('touchend', handleTouchEnd);
      };
    }
  }, [activeFilter]);

  useEffect(() => {
    if (onMapClick) {
      onMapClick.current = () => setActiveFilter(null);
    }
  }, [onMapClick]);

  const handleFilterClick = (filter) => {
if (onFilterOpen) onFilterOpen();
    setSelectedTripId(null); // Скрываем список поездок
    setActiveFilter(activeFilter === filter ? null : filter);
  };

const handlePriceChange = (e, type) => {
  const value = parseInt(e.target.value, 10);
  const next = { ...filters, [type]: value };
  setFilters(next);

  // Debounce, чтобы фильтр не считался на каждый пиксель движения ползунка
  if (priceDebounceRef.current) clearTimeout(priceDebounceRef.current);
  priceDebounceRef.current = setTimeout(() => {
    applyFilter('price', next);
  }, 120);
};

const handleAgeChange = (e) => {
  const value = parseInt(e.target.value, 10);
  const next = { ...filters, age: value };
  setFilters(next);
  applyFilter('age', next);
};

const handleLeisureTypeSelect = (value) => {
  const next = { ...filters, leisureType: value };
  setFilters(next);
  applyFilter('leisureType', next);
  setActiveFilter(null);
};

const handleDifficultySelect = (value) => {
  const next = { ...filters, difficulty: value };
  setFilters(next);
  applyFilter('difficulty', next);
  setActiveFilter(null);
};

  const handleDateChange = (dates) => {
    const [start, end] = dates;
    setFilters(prev => ({
      ...prev,
      dateFrom: start,
      dateTo: end
    }));
  };

  const applyDateFilter = () => {
    if (filters.dateFrom && filters.dateTo) {
      applyFilter('date');
      setActiveFilter(null);
    }
  };

  const cancelDateFilter = () => {
    setActiveFilter(null);
  };

  return (
    <div className={styles.filters} ref={filtersRef}>
      <div className={styles.filterWrapper}>
        <button 
          onClick={() => handleFilterClick('price')}
          className={`${styles.filterButton} ${filters.priceFrom || filters.priceTo ? styles.active : ''}`}
        >
          Цена
          {(filters.priceFrom || filters.priceTo) && (
            <>
              <span className={styles.filterValue}>
                {filters.priceFrom ? `${filters.priceFrom.toLocaleString()}₽` : '0₽'}
                {filters.priceTo ? ` - ${filters.priceTo.toLocaleString()}₽` : ' - 1 000 000₽'}
              </span>
              <span 
                className={styles.clearIcon}
                onClick={(e) => {
                  e.stopPropagation();
                  removeFilter('price');
                }}
              >×</span>
            </>
          )}
        </button>
        {activeFilter === 'price' && (
          <div className={styles.filterDropdown}>
            <div className={styles.rangeContainer}>
              <div className={styles.rangeLabels}>
                <span>0₽</span>
                <span>1 000 000₽</span>
              </div>
              <div className={styles.rangeInputs}>
                <input
                  type="range"
                  min="0"
                  max="1000000"
                  step="10000"
                  value={filters.priceFrom || 0}
                  onChange={(e) => handlePriceChange(e, 'priceFrom')}
                  className={styles.rangeSlider}
                />
                <input
                  type="range"
                  min="0"
                  max="1000000"
                  step="10000"
                  value={filters.priceTo || 1000000}
                  onChange={(e) => handlePriceChange(e, 'priceTo')}
                  className={styles.rangeSlider}
                />
              </div>
              <div className={styles.rangeValues}>
                <span>{filters.priceFrom ? filters.priceFrom.toLocaleString() : '0'}₽</span>
                <span>{filters.priceTo ? filters.priceTo.toLocaleString() : '1 000 000'}₽</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={styles.filterWrapper}>
        <button 
          className={`${styles.filterButton} ${filters.leisureType ? styles.active : ''}`}
          onClick={() => handleFilterClick('leisureType')}
        >
          Вид отдыха
          {filters.leisureType && (
            <>
              <span className={styles.filterValue}>{leisureTypeLabels[filters.leisureType]}</span>
              <span 
                className={styles.clearIcon}
                onClick={(e) => {
                  e.stopPropagation();
                  removeFilter('leisureType');
                }}
              >×</span>
            </>
          )}
        </button>
        {activeFilter === 'leisureType' && (
          <div className={styles.filterDropdown}>
            {Object.entries(leisureTypeLabels).map(([key, label]) => (
              <button
                key={key}
                className={`${styles.filterOption} ${filters.leisureType === key ? styles.selected : ''}`}
                onClick={() => handleLeisureTypeSelect(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={styles.filterWrapper}>
        <button 
          className={`${styles.filterButton} ${filters.difficulty ? styles.active : ''}`}
          onClick={() => handleFilterClick('difficulty')}
        >
          Сложность
          {filters.difficulty && (
            <>
              <span className={styles.filterValue}>{difficultyLabels[filters.difficulty]}</span>
              <span 
                className={styles.clearIcon}
                onClick={(e) => {
                  e.stopPropagation();
                  removeFilter('difficulty');
                }}
              >×</span>
            </>
          )}
        </button>
        {activeFilter === 'difficulty' && (
          <div className={styles.filterDropdown}>
            {Object.entries(difficultyLabels).map(([key, label]) => (
              <button
                key={key}
                className={`${styles.filterOption} ${filters.difficulty === key ? styles.selected : ''}`}
                onClick={() => handleDifficultySelect(key)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={styles.filterWrapper}>
        <button 
          className={`${styles.filterButton} ${filters.age ? styles.active : ''}`}
          onClick={() => handleFilterClick('age')}
        >
          Возраст
          {filters.age && (
            <>
              <span className={styles.filterValue}>{filters.age}</span>
              <span 
                className={styles.clearIcon}
                onClick={(e) => {
                  e.stopPropagation();
                  removeFilter('age');
                }}
              >×</span>
            </>
          )}
        </button>
        {activeFilter === 'age' && (
          <div className={styles.filterDropdown}>
            <div className={styles.rangeContainer}>
              <div className={styles.rangeLabels}>
                <span>0</span>
                <span>100</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                value={filters.age || 0}
                onChange={handleAgeChange}
                className={styles.rangeSliderSingle}
              />
              <div className={styles.rangeValue}>
                {filters.age || 0}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className={styles.filterWrapper}>
        <button 
          className={`${styles.filterButton} ${
            (filters.dateFrom && filters.dateTo && 
             (filters.dateFrom.getTime() !== today.getTime() || filters.dateTo.getTime() !== twoWeeksLater.getTime())) 
              ? styles.active 
              : ''
          }`}
          onClick={() => handleFilterClick('date')}
        >
          Дата
          {(filters.dateFrom && filters.dateTo) && (
            <>
              <span className={styles.filterValue}>
                {filters.dateFrom.toLocaleDateString('ru')} - {filters.dateTo.toLocaleDateString('ru')}
              </span>
              <span 
                className={styles.clearIcon}
                onClick={(e) => {
                  e.stopPropagation();
                  removeFilter('date');
                }}
              >×</span>
            </>
          )}
        </button>
        {activeFilter === 'date' && (
          <div className={styles.filterDropdownFullScreen} ref={datePickerRef}>
            <div className={styles.datePickerContainer}>
  <div className={styles.datePickerCalendarWrap}>
    <DatePicker
      locale="ru"
      selected={filters.dateFrom}
      onChange={handleDateChange}
      startDate={filters.dateFrom}
      endDate={filters.dateTo}
      selectsRange
      inline
      minDate={new Date()}
      dateFormat="dd.MM.yyyy"
      className={styles.mobileCalendar}
    />
  </div>

  <div className={styles.datePickerButtons}>
    <button onClick={cancelDateFilter} className={styles.cancelButton}>
      Отмена
    </button>
    <button onClick={applyDateFilter} className={styles.applyButton}>
      Применить
    </button>
  </div>
</div>

          </div>
        )}
      </div>
    </div>
  );
}