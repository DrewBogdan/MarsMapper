import csv
import db_retrieval as db

# lat 1 8 digit, lat 2 4 digit
def find_closest(lat, long, temp_dict):
    key = search(lat, sorted(list(temp_dict.keys())))
    return temp_dict[key][search(long, sorted(list(temp_dict[key].keys())))]

def search(value, keys):
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
    with open('../data/test-temp-large-area.csv', mode='r') as csvfile:
        reader = csv.reader(csvfile)
        for row in reader:
            temperature.append(row)

    elevation = []
    with open('../data/test-large-area.csv', mode='r') as csvfile:
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


    insert_statement = "INSERT INTO MarsPoints (id, latitude, longitude, elevation, avg_temp, max_temp, min_temp, temp_variation) VALUES"
    with open('../data/big-mars-combined.sql', mode='w', newline='') as output:
        output.write(insert_statement)
        for elev in elevation:
            lat = round(float(elev[1]),4)
            long = round(float(elev[2]),4)
            if lat in temp_dict and long in temp_dict[lat]:
                temp_data = temp_dict[lat][long]
                combined_row = elev + temp_data
                output.write(f"\n   (0, {combined_row[1]}, {combined_row[2]}, {combined_row[3]}, {combined_row[4]}, {combined_row[5]}, {combined_row[6]}, {combined_row[7]}),")
            else:
                combined_row = elev + find_closest(lat, long, temp_dict)
                output.write(f"\n   (0, {combined_row[1]}, {combined_row[2]}, {combined_row[3]}, {combined_row[4]}, {combined_row[5]}, {combined_row[6]}, {combined_row[7]}),")

    # connection = db.connect_to_db()
    # cursor = connection.cursor()
    # try:
    #     cursor.execute(insert_statement[:-2] + ";")
    #     connection.commit()
    # finally:
    #     cursor.close()
    #     connection.close()


    # with open('../data/big-mars-combined.sql', mode='w', newline='') as output:
    #     output.write("INSERT INTO MarsPoints (ID, latitude, longitude, elevation, average_temperature, maximum_temperature, minimum_temperature, temperature_variation) VALUES\n")
    #     for row in combined:
    #         output.write(f"   ({row[0]}, {row[1]}, {row[2]}, {row[3]}, {row[4]}, {row[5]}, {row[6]}, {row[7]}),\n")

combine()
