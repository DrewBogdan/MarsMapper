from configparser import ConfigParser
import mysql.connector as mysql
#import pandas as pd

def connect_to_db():
    config = ConfigParser()
    config.read('config.ini')

    db = mysql.connect(
        user=config['db']['user'],
        password=config['db']['password'],
        database=config['db']['database'],
        host=config['db']['host']
    )
    cursor = db.cursor()

    cursor.execute('SHOW TABLES')
    bases = cursor.fetchall()

    print(bases)


connect_to_db()