from configparser import ConfigParser
import mysql.connector as mysql


# import pandas as pd

def connect_to_db():
    config = ConfigParser()
    config.read('config.ini')

    db = mysql.connect(
        user=config['db']['user'],
        password=config['db']['password'],
        database=config['db']['database'],
        host=config['db']['host']
    )
    return db


def query_db(query):
    db = connect_to_db()
    cursor = db.cursor()
    try:
        cursor.execute(query)
        return cursor.fetchall()
    finally:
        cursor.close()
        db.close()
