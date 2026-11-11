/** 查询天气预报，并对超出预报范围的日期明确降级。 */
import { createSource, optionalDate, requireText, ToolInputError, type TravelTool } from './types.js'
import { fetchJson } from './http.js'

const OPEN_METEO_DOCS = 'https://open-meteo.com/en/docs'

interface GeocodingResult {
  name: string
  latitude: number
  longitude: number
  country?: string
  admin1?: string
  timezone?: string
}

interface ForecastResponse {
  hourly?: {
    time?: string[]
    temperature_2m?: Array<number | null>
    is_day?: Array<number | null>
  }
  daily?: {
    time?: string[]
    sunrise?: string[]
    sunset?: string[]
    weather_code?: number[]
    temperature_2m_min?: number[]
    temperature_2m_max?: number[]
    precipitation_probability_max?: number[]
    wind_speed_10m_max?: number[]
  }
}

/** 获取城市逐日天气，未来 16 天以外、已过去日期和空结果都显式标记。 */
export const weatherTool: TravelTool = {
  definition: {
    type: 'function',
    function: {
      name: 'get_weather',
      description: '查询目的地逐日天气、日出和日落时间，最多提供未来 16 天的预报；过去日期和更远日期不推断天气。日出日落为地点当地时间。',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: '城市或地区名称' },
          start_date: { type: 'string', description: '可选，YYYY-MM-DD' },
          end_date: { type: 'string', description: '可选，YYYY-MM-DD' }
        },
        required: ['city'],
        additionalProperties: false
      }
    }
  },
  provider: 'Open-Meteo',
  kind: 'weather',
  connector: 'weather',
  sourceUrl: OPEN_METEO_DOCS,
  /** 解析城市与日期范围，按查询形态请求天气服务。 */
  async execute(args, _context, signal) {
    const city = requireText(args, 'city', 1, 80)
    const startDate = optionalDate(args.start_date)
    const endDate = optionalDate(args.end_date)
    if (endDate && !startDate) throw new ToolInputError('查询结束日期时，也必须提供开始日期。')
    if (startDate && endDate && endDate < startDate) throw new ToolInputError('结束日期不能早于开始日期。')

    const geocoding = await fetchJson<{ results?: GeocodingResult[] }>(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=5&language=zh&format=json`,
      signal
    )
    const place = geocoding.results?.find((item) => item.name) ?? geocoding.results?.[0]
    if (!place) {
      const summary = `没有找到“${city}”的天气位置，请补充省份或更具体的地点。`
      return {
        output: summary,
        sources: [createSource(`天气位置：${city}`, OPEN_METEO_DOCS, 'Open-Meteo', 'weather', summary, 'unavailable')]
      }
    }

    const today = calendarDateInTimeZone(new Date(), place.timezone)
    const latestDate = addDays(today, 15)
    const location = `${place.name}${place.admin1 ? `（${place.admin1}）` : ''}`
    if (startDate && startDate < today && (!endDate || endDate < today)) {
      const summary = `${location} 的目标日期已经过去，当前预报服务不提供历史天气。`
      return {
        output: summary,
        sources: [createSource(`天气预报范围：${place.name}`, OPEN_METEO_DOCS, 'Open-Meteo', 'weather', summary, 'unavailable')]
      }
    }
    if (startDate && startDate > latestDate) {
      const summary = `${location} 的 ${startDate} 超出当前逐日预报范围；建议出发前 3–7 天复查。`
      return {
        output: `${summary} 不要据此生成具体穿搭。`,
        sources: [createSource(`天气预报范围：${place.name}`, OPEN_METEO_DOCS, 'Open-Meteo', 'weather', summary, 'unavailable')]
      }
    }

    const queryStart = startDate && startDate < today ? today : startDate
    const queryEnd = endDate && endDate > latestDate ? latestDate : endDate
    if (queryStart && queryEnd && queryEnd < queryStart) {
      const summary = `${location} 的目标日期已经过去，当前预报服务不提供历史天气。`
      return {
        output: summary,
        sources: [createSource(`天气预报范围：${place.name}`, OPEN_METEO_DOCS, 'Open-Meteo', 'weather', summary, 'unavailable')]
      }
    }

    const params = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      hourly: 'temperature_2m,is_day',
      daily: 'weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
      timezone: place.timezone || 'auto'
    })
    if (queryStart) {
      params.set('start_date', queryStart)
      params.set('end_date', queryEnd ?? queryStart)
    } else {
      params.set('forecast_days', '16')
    }
    const forecast = await fetchJson<ForecastResponse>(`https://api.open-meteo.com/v1/forecast?${params}`, signal)
    const daily = forecast.daily
    if (!daily?.time?.length) throw new Error('天气服务没有返回逐日预报。')

    const rows = daily.time.map((date, index) => {
      const values = [daily.temperature_2m_min?.[index], daily.temperature_2m_max?.[index]]
        .filter((value): value is number => typeof value === 'number')
      const temperature = values.length === 2 ? `${values[0]}–${values[1]}°C` : '温度未知'
      const rain = daily.precipitation_probability_max?.[index]
      const wind = daily.wind_speed_10m_max?.[index]
      const dayNight = dayNightTemperatureSummary(date, forecast.hourly)
      const solarTimes = solarTimeSummary(daily.sunrise?.[index], daily.sunset?.[index])
      return `${date}：${weatherLabel(daily.weather_code?.[index])}，全日 ${temperature}，${dayNight}${solarTimes ? `，${solarTimes}` : ''}，降水概率 ${rain ?? '未知'}%，最大风速 ${wind ?? '未知'} km/h`
    }).filter((row) => (!queryStart || row.slice(0, 10) >= queryStart) && (!queryEnd || row.slice(0, 10) <= queryEnd))

    if (rows.length === 0) throw new Error('天气服务未返回目标日期的预报。')
    const notices = [
      startDate && startDate < today ? `目标日期中的过去部分（截至 ${today}）不在预报内。` : '',
      endDate && endDate > latestDate ? `预报只覆盖到 ${latestDate}；更远日期请出发前复查。` : ''
    ].filter(Boolean)
    const summary = `${location}；逐日天气预报如下，白天/夜间分组采用逐小时预报的昼夜标记，昼夜均温差按两组小时预报均值计算；实际天气会变化。${notices.length ? ` ${notices.join(' ')}` : ''}\n${rows.join('\n')}`
    const evidenceSummary = `${location}逐日预报（白夜按逐小时昼夜标记分组，均温差按组均值计算）：\n${rows.join('\n')}`
    const status = notices.length ? 'partial' : 'success'
    return {
      output: summary,
      sources: [createSource(`逐日天气：${place.name}`, OPEN_METEO_DOCS, 'Open-Meteo', 'weather', evidenceSummary, status)]
    }
  }
}

/** 按目的地时区取当天日期；缺少或无效的 IANA 时区时退回 UTC。 */
function calendarDateInTimeZone(date: Date, timeZone?: string): string {
  const format = (zone: string): Record<string, string> => {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date)
    return Object.fromEntries(parts.map((part) => [part.type, part.value]))
  }

  let calendar: Record<string, string>
  try {
    calendar = format(timeZone || 'UTC')
  } catch {
    calendar = format('UTC')
  }

  const fallbackDate = date.toISOString().slice(0, 10)
  const year = calendar.year ?? fallbackDate.slice(0, 4)
  const month = calendar.month ?? fallbackDate.slice(5, 7)
  const day = calendar.day ?? fallbackDate.slice(8, 10)
  return `${year}-${month}-${day}`
}

/** 从服务返回的本地 ISO 时间中提取日出日落时刻，不自行计算天文时间。 */
function solarTimeSummary(sunrise?: string, sunset?: string): string {
  const localTime = (value: string | undefined): string => {
    const match = value?.match(/T(\d{2}:\d{2})(?::\d{2})?(?:[+-]\d{2}:?\d{2}|Z)?$/u)
    return match?.[1] ?? '未知'
  }
  if (!sunrise && !sunset) return ''
  return `日出 ${localTime(sunrise)}，日落 ${localTime(sunset)}`
}

/** 使用服务返回的昼夜标记分组小时气温，不从日最高/最低温推断时段。 */
function dayNightTemperatureSummary(
  date: string,
  hourly: ForecastResponse['hourly']
): string {
  const times = hourly?.time
  const temperatures = hourly?.temperature_2m
  const dayFlags = hourly?.is_day
  if (!times || !temperatures || !dayFlags) return '白天/夜间分时预报未知'

  const dayValues: number[] = []
  const nightValues: number[] = []
  times.forEach((time, index) => {
    const temperature = temperatures[index]
    if (!time.startsWith(`${date}T`) || typeof temperature !== 'number' || !Number.isFinite(temperature)) return
    if (dayFlags[index] === 1) dayValues.push(temperature)
    if (dayFlags[index] === 0) nightValues.push(temperature)
  })
  if (!dayValues.length || !nightValues.length) return '白天/夜间分时预报未知'

  const dayAverage = average(dayValues)
  const nightAverage = average(nightValues)
  const averageDifference = Math.round((dayAverage - nightAverage) * 10) / 10
  return `白天 ${formatRange(dayValues)}，夜间 ${formatRange(nightValues)}，昼夜均温差约 ${formatTemperature(averageDifference)}°C`
}

/** 计算分时预报的样本均值，用于给出可解释的昼夜均温差。 */
function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** 格式化逐小时温度范围，最多保留天气服务提供的一位小数。 */
function formatRange(values: number[]): string {
  return `${formatTemperature(Math.min(...values))}–${formatTemperature(Math.max(...values))}°C`
}

/** 减少浮点噪声并保留至多一位小数。 */
function formatTemperature(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}

/** 按 UTC 日期计算预报上界，避免受用户设备时区格式影响。 */
function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + days)
  return value.toISOString().slice(0, 10)
}

/** 将 Open-Meteo 天气代码转换为中文描述，未知代码保留不确定性。 */
function weatherLabel(code?: number): string {
  if (code === undefined) return '天气未知'
  if (code === 0) return '晴'
  if ([1, 2, 3].includes(code)) return '多云'
  if ([45, 48].includes(code)) return '雾'
  if ([51, 53, 55, 56, 57].includes(code)) return '毛毛雨/冻毛毛雨'
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '雨'
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '雪'
  if ([95, 96, 99].includes(code)) return '雷暴'
  return '天气代码待核验'
}
