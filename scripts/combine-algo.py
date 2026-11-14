import csv


# lat 1 8 digit, lat 2 4 digit
def find_closest(lat, long, temp_dict):
    key = search(lat, sorted(list(temp_dict.keys())))
    print(f"Closest latitude: {key}")
    return temp_dict[key][search(long, sorted(list(temp_dict[key].keys())))]

def search(value, keys):
    print("Search Start")
    print(keys)
    if len(keys) == 1:
        return keys[0]
    if len(keys) == 2:
        if keys[0] > value and keys[1] > value:
            return keys[0]
        if keys[0] < value and keys[1] < value:
            return keys[1]
        else:
            diff1 = abs(keys[0]-value)
            diff2 = abs(keys[1]-value)
            if diff1 > diff2:
                return keys[1]
            else:
                return keys[0]

    mid = len(keys) // 2
    if keys[mid] == value:
        return keys[mid]
    elif keys[mid] < value:
        return search(value, keys[mid + 1:])
    else:
        return search(value, keys[:mid])

def combine():
    temperature = []
    with open('../data/mars-temp-polygon.csv', mode='r') as csvfile:
        reader = csv.reader(csvfile)
        for row in reader:
            temperature.append(row)

    elevation = []
    with open('../data/mars-polygon.csv', mode='r') as csvfile:
        reader = csv.reader(csvfile)
        for row in reader:
            elevation.append(row)

    temp_dict = {}

    temperature = temperature[1:]  # Skip header
    elevation = elevation[1:]  # Skip header

    for temp in temperature:
        lat = round(float(temp[1]),4)
        long = round(float(temp[2]),4)
        if temp_dict.get(lat) is None:
            temp_dict[lat] = {}
        temp_dict[lat][long] = temp[3:]

    combined = []

    for elev in elevation:
        lat = round(float(elev[1]),4)
        long = round(float(elev[2]),4)
        print(f"Checking elevation coordinates: ({lat}, {long})")
        if lat in temp_dict and long in temp_dict[lat]:
            temp_data = temp_dict[lat][long]
            combined_row = elev + temp_data
            combined.append(combined_row)
        else:
            combined.append(elev + find_closest(lat, long, temp_dict))


    print(combined)

    with open('../data/mars-combined.csv', mode='w', newline='') as csvfile:
        writer = csv.writer(csvfile)
        writer.writerow(['ID', 'latitude', 'longitude', 'elevation', 'Average Temperature (C)', 'Maximum Temperature (C)', 'Minimum Temperature (C)', 'Temperature Variation (C)'])
        for row in combined:
            writer.writerow(row)
combine()